/**
 * 通用 ACP 驱动：拉起一个讲 ACP 的子进程，完成 initialize → newSession → prompt，
 * 按 `session/update` 流式收集正文，并用动态审批把工具收敛到只读。
 *
 * 与 OpenAI 兼容入口的差别在于「谁执行工具」：这里不再由本进程提供工具，工具链
 * 完全由 ACP agent 自带。审批只决定放行还是拒绝，因此不覆盖 agent 的请求头、
 * 不注入自定义 User-Agent，也不把 agent 包成 HTTP 网关。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import { AnswerSchema, redactText, type Answer } from '@gt6ce/shared';

import {
  AgentError,
  parseRelevanceVerdict,
  type AnalysisOutcome,
  type AnalysisStep,
  type PromptTemplate,
  type RelevanceVerdict,
} from './analyzer.ts';
import { ModelError, type ModelEntry } from './model-pool.ts';
import { recoverFromText } from './output-errors.ts';
import { prepareAcpChildEnv } from './vibe-env.ts';

/** ACP 进程的启动可用性：只做命令解析，不发起请求。 */
export function resolveAcpCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const hasSeparator = command.includes('/') || command.includes('\\') || isAbsolute(command);
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map((extension) => extension.toLowerCase())
      : [''];
  const candidates: string[] = [];
  if (hasSeparator) {
    candidates.push(command);
  } else {
    const pathValue = env.PATH ?? env.Path ?? '';
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
      if (process.platform !== 'win32') {
        candidates.push(join(dir, command));
        continue;
      }
      const lower = command.toLowerCase();
      if (extensions.some((extension) => lower.endsWith(extension))) {
        candidates.push(join(dir, command));
      } else {
        for (const extension of extensions) {
          candidates.push(join(dir, `${command}${extension}`));
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      if (process.platform !== 'win32') {
        accessSync(candidate, constants.X_OK);
      }
      return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

/** 入口声明的 ACP 命令是否可执行；非 ACP 入口恒为 false。 */
export function acpCommandAvailable(
  entry: ModelEntry,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (entry.driver !== 'acp' || !entry.acp) {
    return false;
  }
  return resolveAcpCommand(entry.acp.command, env) !== undefined;
}

const READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'grep',
  'glob',
  'list',
  'list_directory',
  'search',
  'codebase_search',
  'tree',
  'stat',
  'view',
  'skill',
]);

const SECRET_MARKERS = [
  'MODEL_KEY',
  'MISTRAL_API_KEY',
  'CLINEPASS',
  'GITHUB_TOKEN',
  'GT6CE_APP_PRIVATE_KEY',
  'printenv',
  '/proc/self/environ',
  '/proc/1/environ',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
];

const ENV_FILE_SUFFIXES = ['.env', '.envrc'];
const READ_ONLY_TITLE_PATTERN = /(^|[\s_-])(read|list|grep|search|glob|view|tree|stat)([\s_-]|$)/;

function safeJson(value: unknown, limit = 4000): string {
  if (value === undefined) {
    return '';
  }
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}

/**
 * 工具调用是否可能读到凭据文件。
 *
 * 按路径片段判断而不是子串匹配：`.env`、`.env.local`、`prod.env` 都算，
 * `environment` 这类普通单词不算。
 */
function touchesEnvFile(text: string): boolean {
  const tokens = text.split(/[^A-Za-z0-9._\-/\\]+/);
  return tokens.some((token) => {
    const base = (token.replaceAll('\\', '/').split('/').pop() ?? '').toLowerCase();
    return (
      ENV_FILE_SUFFIXES.some((suffix) => base === suffix || base.startsWith(`${suffix}.`)) ||
      ENV_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix)) ||
      base.includes('.env.')
    );
  });
}

/** 工具调用是否可能读到凭据；命中即拒绝，即使它声明成只读。 */
function touchesSecrets(text: string): boolean {
  const lowered = text.toLowerCase();
  if (SECRET_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
    return true;
  }
  return touchesEnvFile(text);
}

function isReadOnlyTool(params: RequestPermissionRequest): boolean {
  const call = params.toolCall;
  const name = (call.name ?? '').toLowerCase();
  const title = (call.title ?? '').toLowerCase();
  if (call.kind === 'read' || call.kind === 'search' || call.kind === 'think') {
    return true;
  }
  // 已知的写/执行类 kind 优先于工具名：名为 read 的 execute 仍然是 execute。
  if (call.kind !== undefined && call.kind !== 'other') {
    return false;
  }
  if (READ_ONLY_TOOL_NAMES.has(name) || READ_ONLY_TOOL_NAMES.has(title)) {
    return true;
  }
  if (call.kind === undefined || call.kind === 'other') {
    return READ_ONLY_TITLE_PATTERN.test(name) || READ_ONLY_TITLE_PATTERN.test(title);
  }
  return false;
}

function pickOption(
  options: readonly PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  const order = allow
    ? (['allow_once', 'allow_always'] as const)
    : (['reject_once', 'reject_always'] as const);
  for (const kind of order) {
    const found = options.find((option) => option.kind === kind);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function permissionResponse(
  params: RequestPermissionRequest,
  allow: boolean,
): RequestPermissionResponse {
  const option = pickOption(params.options, allow);
  if (!option) {
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

function decidePermission(params: RequestPermissionRequest): RequestPermissionResponse {
  const call = params.toolCall;
  const haystack = [
    call.name ?? '',
    call.title ?? '',
    typeof call.rawInput === 'string' ? call.rawInput : safeJson(call.rawInput),
  ].join('\n');
  if (touchesSecrets(haystack)) {
    return permissionResponse(params, false);
  }
  return permissionResponse(params, isReadOnlyTool(params));
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

const ZERO_TOKENS: TokenTotals = { input: 0, output: 0, total: 0 };

export interface AcpPromptResult {
  readonly text: string;
  readonly stopReason: string;
  readonly tokens: TokenTotals;
}

export interface AcpSessionOptions {
  readonly entry: ModelEntry;
  readonly apiKey: string;
  readonly cwd: string;
  /** 额外工作区根（绝对路径）；用于让 ACP agent 读取 cwd 之外的 inputs/outputs。 */
  readonly additionalDirectories?: readonly string[];
  readonly softTimeoutMs?: number;
  readonly loopRepeatThreshold?: number;
  readonly timeoutMs?: number;
  /** 握手阶段的上限，默认 60 秒；仅用于测试注入。 */
  readonly initTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStep?: (step: AnalysisStep) => void;
  readonly onStderrLine?: (line: string) => void;
}

interface CachedToolCall {
  readonly toolCallId: string;
  readonly name?: string | null;
  readonly title?: string | null;
  readonly kind?: ToolKind | null;
  readonly rawInput?: unknown;
}

interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const INIT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 10_000;

class AcpSession {
  readonly #child: ChildProcess;
  readonly #connection: ClientSideConnection;
  readonly #cleanup: () => void;
  readonly #options: AcpSessionOptions;
  readonly #stderrTail: string[] = [];
  readonly #stopTimers: Array<() => void> = [];
  readonly #abortHandler: () => void;

  #stderrBuffer = '';
  #failure: Error | undefined;
  #exit: ExitInfo | undefined;
  #resolveFailure!: () => void;
  readonly #failureSignal: Promise<void>;
  #sessionId = '';
  #steps = 0;
  #seenTools = new Set<string>();
  #toolCalls = new Map<string, CachedToolCall>();
  #lastSignature: string | undefined;
  #repeatCount = 0;
  #cancelSent = false;
  #cancelRequested = false;
  #denyAll = false;
  #turnText = '';
  #lastUsage: TokenTotals = ZERO_TOKENS;
  #closing = false;

  constructor(options: AcpSessionOptions, child: ChildProcess, envCleanup: () => void) {
    this.#options = options;
    this.#child = child;
    this.#cleanup = envCleanup;
    this.#failureSignal = new Promise<void>((resolve) => {
      this.#resolveFailure = resolve;
    });

    child.on('error', (error) => {
      this.#failure ??= error;
      this.#resolveFailure();
    });
    child.on('exit', (code, signal) => {
      this.#exit ??= { code, signal };
      this.#failure ??= new Error(`ACP 进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.#resolveFailure();
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#consumeStderr(chunk);
    });

    const input = Writable.toWeb(
      child.stdin as unknown as Writable,
    ) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(
      child.stdout as unknown as Readable,
    ) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const client: Client = {
      requestPermission: (params) => this.#requestPermission(params),
      sessionUpdate: (params) => this.#sessionUpdate(params),
    };
    this.#connection = new ClientSideConnection(() => client, stream);

    this.#abortHandler = () => this.#requestCancel('aborted');
    options.abortSignal?.addEventListener('abort', this.#abortHandler, { once: true });
    this.#armTimers();
  }

  #consumeStderr(chunk: string): void {
    this.#stderrBuffer += chunk;
    let index = this.#stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#stderrBuffer.slice(0, index).replace(/\r$/, '');
      this.#stderrBuffer = this.#stderrBuffer.slice(index + 1);
      this.#pushStderr(line);
      index = this.#stderrBuffer.indexOf('\n');
    }
    if (this.#stderrBuffer.length > 8192) {
      this.#pushStderr(this.#stderrBuffer);
      this.#stderrBuffer = '';
    }
  }

  #pushStderr(line: string): void {
    const key = this.#options.apiKey;
    const redacted = key ? line.split(key).join('[redacted]') : line;
    this.#stderrTail.push(redacted);
    if (this.#stderrTail.length > 200) {
      this.#stderrTail.shift();
    }
    this.#options.onStderrLine?.(redacted);
  }

  #stderr(): string {
    const tail = [...this.#stderrTail];
    if (this.#stderrBuffer) {
      const key = this.#options.apiKey;
      tail.push(key ? this.#stderrBuffer.split(key).join('[redacted]') : this.#stderrBuffer);
    }
    return tail.join('\n').slice(-6000);
  }

  #armTimers(): void {
    const soft = this.#options.softTimeoutMs;
    if (soft !== undefined && soft > 0) {
      const timer = setTimeout(() => this.#requestCancel('soft-timeout'), soft);
      timer.unref();
      this.#stopTimers.push(() => clearTimeout(timer));
    }
    const hard = this.#options.timeoutMs;
    if (hard !== undefined && hard > 0) {
      const timer = setTimeout(() => {
        this.#requestCancel('timeout');
        const kill = setTimeout(() => this.#kill(), KILL_GRACE_MS);
        kill.unref();
        this.#stopTimers.push(() => clearTimeout(kill));
      }, hard);
      timer.unref();
      this.#stopTimers.push(() => clearTimeout(timer));
    }
  }

  #requestCancel(reason: string): void {
    this.#cancelRequested = true;
    if (this.#cancelSent || this.#sessionId === '') {
      return;
    }
    this.#cancelSent = true;
    try {
      void this.#connection.cancel({ sessionId: this.#sessionId }).catch(() => {
        // 进程可能已经退出；取消是尽力而为。
      });
    } catch {
      // 连接已关闭；取消是尽力而为。
    }
    this.#options.onStderrLine?.(`[acp] session/cancel (${reason})`);
  }

  #requestPermission(params: RequestPermissionRequest): RequestPermissionResponse {
    // 部分 ACP agent（包括 vibe-acp）的审批请求只带 toolCallId，kind/标题/参数都在
    // 之前的 tool_call 通知里。这里按 ID 合并，避免只读工具被误判成未知工具。
    const cached = this.#toolCalls.get(params.toolCall.toolCallId);
    const request = cached
      ? { ...params, toolCall: { ...cached, ...params.toolCall } }
      : params;
    if (this.#denyAll) {
      return permissionResponse(request, false);
    }
    return decidePermission(request);
  }

  #rememberToolCall(update: ToolCallUpdate): void {
    const previous = this.#toolCalls.get(update.toolCallId);
    const next: {
      toolCallId: string;
      name?: string | null;
      title?: string | null;
      kind?: ToolKind | null;
      rawInput?: unknown;
    } = { toolCallId: update.toolCallId };
    const name = update.name ?? previous?.name;
    if (name !== undefined && name !== null) {
      next.name = name;
    }
    const title = update.title ?? previous?.title;
    if (title !== undefined && title !== null) {
      next.title = title;
    }
    const kind = update.kind ?? previous?.kind;
    if (kind !== undefined && kind !== null) {
      next.kind = kind;
    }
    if (update.rawInput !== undefined) {
      next.rawInput = update.rawInput;
    } else if (previous && 'rawInput' in previous) {
      next.rawInput = previous.rawInput;
    }
    this.#toolCalls.set(update.toolCallId, next);
  }

  #sessionUpdate(params: SessionNotification): void {
    const update = params.update;
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.#rememberToolCall(update);
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const text = update.content.text;
      if (text !== '') {
        this.#turnText += text;
      }
      return;
    }
    if (update.sessionUpdate !== 'tool_call') {
      return;
    }
    if (this.#seenTools.has(update.toolCallId)) {
      return;
    }
    this.#seenTools.add(update.toolCallId);
    this.#steps += 1;
    this.#options.onStep?.({
      index: this.#steps - 1,
      text: '',
      toolCalls: [{ name: update.name ?? update.title, input: update.rawInput }],
    });
    const signature = `${update.name ?? ''}:${update.title ?? ''}:${stableStringify(update.rawInput)}`;
    if (signature === this.#lastSignature) {
      this.#repeatCount += 1;
    } else {
      this.#lastSignature = signature;
      this.#repeatCount = 1;
    }
    const threshold = Math.max(1, this.#options.loopRepeatThreshold ?? 3);
    if (this.#repeatCount >= threshold) {
      this.#requestCancel('loop');
    }
  }

  #guard<T>(promise: Promise<T>, phase: string): Promise<T> {
    return Promise.race([
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      this.#failureSignal.then(() => ({
        ok: false as const,
        error: this.#failure ?? new Error('ACP 进程不可用'),
      })),
    ]).then((outcome) => {
      if (!outcome.ok) {
        throw mapAcpFailure(outcome.error, this.#stderr(), this.#exit, phase);
      }
      return outcome.value;
    });
  }

  async start(): Promise<void> {
    const initTimeoutMs = this.#options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#kill();
        reject(new ModelError('config', 0, 0, 'ACP 初始化超时'));
      }, initTimeoutMs);
      timer.unref();
    });
    // newSession 阶段不再 race 这个 Promise；先标记已处理，避免超时迟到时触发未处理拒绝。
    timeout.catch(() => {});
    try {
      const initialize = this.#connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const response = await this.#guard(Promise.race([initialize, timeout]), 'initialize');
      if (response.protocolVersion !== PROTOCOL_VERSION) {
        throw new ModelError(
          'config',
          0,
          0,
          `ACP 协议版本不匹配: ${String(response.protocolVersion)}`,
        );
      }
      const session = await this.#guard(
        this.#connection.newSession({
          cwd: this.#options.cwd,
          mcpServers: [],
          ...(this.#options.additionalDirectories &&
          this.#options.additionalDirectories.length > 0
            ? { additionalDirectories: [...this.#options.additionalDirectories] }
            : {}),
        }),
        'session/new',
      );
      this.#sessionId = session.sessionId;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async prompt(text: string, formatOnly = false): Promise<AcpPromptResult> {
    this.#turnText = '';
    this.#lastSignature = undefined;
    this.#repeatCount = 0;
    this.#denyAll = formatOnly;
    try {
      const response = await this.#guard(
        this.#connection.prompt({
          sessionId: this.#sessionId,
          prompt: [{ type: 'text', text }],
        }),
        'session/prompt',
      );
      if (response.usage) {
        this.#lastUsage = {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
          total: response.usage.totalTokens,
        };
      }
      return {
        text: this.#turnText,
        stopReason: response.stopReason,
        tokens: this.#lastUsage,
      };
    } catch (error) {
      if (this.#cancelRequested) {
        return { text: this.#turnText, stopReason: 'cancelled', tokens: this.#lastUsage };
      }
      throw error;
    } finally {
      this.#denyAll = false;
    }
  }

  get steps(): number {
    return this.#steps;
  }

  #kill(): void {
    if (this.#child.exitCode !== null) {
      return;
    }
    try {
      this.#child.kill('SIGTERM');
    } catch {
      // 已退出
    }
    const force = setTimeout(() => {
      try {
        this.#child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }, KILL_GRACE_MS);
    force.unref();
  }

  async close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    for (const stop of this.#stopTimers.splice(0)) {
      stop();
    }
    this.#options.abortSignal?.removeEventListener('abort', this.#abortHandler);
    this.#denyAll = true;
    if (this.#child.exitCode === null) {
      this.#kill();
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2000);
        this.#child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        try {
          this.#child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          this.#child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    this.#cleanup();
  }
}

function retryAfterOf(text: string): number {
  const match = /retry[- ]after[^0-9]{0,10}(\d+)/i.exec(text);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function mapAcpFailure(
  error: unknown,
  stderr: string,
  exit: ExitInfo | undefined,
  phase: string,
): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${phase}: ${message}\n${stderr}`.slice(0, 1500);
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'ENOENT') {
    return new ModelError('config', 0, 0, detail);
  }
  const retryAfter = retryAfterOf(detail);
  const status = /\b(401|402|403|429)\b/.exec(detail)?.[1];
  if (status === '401' || status === '403') {
    return new ModelError('auth', Number.parseInt(status, 10), retryAfter, detail);
  }
  if (status === '402') {
    return new ModelError('auth', 402, retryAfter, detail);
  }
  if (status === '429') {
    return new ModelError('rate', 429, retryAfter, detail);
  }
  if (/(quota|insufficient[_\s-]*(credit|funds)|billing)/i.test(detail)) {
    return new ModelError('auth', 402, retryAfter, detail);
  }
  if (/(rate[_\s-]*limit|too many requests)/i.test(detail)) {
    return new ModelError('rate', 429, retryAfter, detail);
  }
  if (/(unauthori[sz]ed|forbidden|invalid[_\s-]*api[_\s-]*key|missing[_\s-]*\w*api[_\s-]*key)/i.test(detail)) {
    return new ModelError('auth', 401, retryAfter, detail);
  }
  if (exit !== undefined) {
    return new ModelError(
      'config',
      0,
      0,
      `ACP 进程异常退出 code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}\n${detail}`.slice(0, 1500),
    );
  }
  return new ModelError('network', 0, retryAfter, detail);
}

async function openAcpSession(options: AcpSessionOptions): Promise<AcpSession> {
  const entry = options.entry;
  if (entry.driver !== 'acp' || !entry.acp) {
    throw new ModelError('config', 0, 0, `入口 ${entry.id} 不是 ACP 入口`);
  }
  const command = resolveAcpCommand(entry.acp.command, options.env ?? process.env);
  if (!command) {
    throw new ModelError('config', 0, 0, `未找到 ACP 命令: ${entry.acp.command}`);
  }
  const prepared = prepareAcpChildEnv({
    preset: entry.acp.preset,
    apiKey: options.apiKey,
    apiKeyTargetEnv: entry.acp.api_key_target_env,
    cwd: options.cwd,
    model: entry.model,
    baseEnv: options.env ?? process.env,
  });
  let child: ChildProcess;
  try {
    child = spawn(command, entry.acp.args, {
      cwd: options.cwd,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    prepared.cleanup();
    throw mapAcpFailure(error, '', undefined, 'spawn');
  }
  const session = new AcpSession(options, child, prepared.cleanup);
  try {
    await session.start();
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

export interface AcpAnalysisOptions extends AcpSessionOptions {
  readonly prompt: PromptTemplate;
}

const FORMAT_INSTRUCTION = [
  '停止调用工具。',
  '把上面已经完成的 issue 分析结论整理成一个 JSON 对象。',
  '只输出 JSON 对象本身，不要解释，不要再读取任何文件。',
  '缺失字段用保守值：confidence 取 low、partial 取 true。',
].join('\n');

function formatPrompt(source: string): string {
  const text = source.trim();
  if (text === '') {
    return FORMAT_INSTRUCTION;
  }
  return `${FORMAT_INSTRUCTION}\n\n已有分析文本：\n${text.slice(-60_000)}`;
}

function promptText(prompt: PromptTemplate): string {
  return `${prompt.system.trim()}\n\n${prompt.user.trim()}`.trim();
}

/** 走 ACP 的 L2 分析：结果契约与 `analyzeIssue` 相同。 */
export async function runAcpAnalysis(options: AcpAnalysisOptions): Promise<AnalysisOutcome> {
  const session = await openAcpSession(options);
  try {
    const first = await session.prompt(promptText(options.prompt));
    let answer: Answer | undefined = recoverFromText(first.text, AnswerSchema);
    let finishReason = first.stopReason;
    let tokens = first.tokens;
    if (!answer) {
      if (first.text.trim() === '' && session.steps === 0) {
        throw new AgentError('ACP 会话没有产出可用于格式化的文本', { steps: 0 });
      }
      try {
        const second = await session.prompt(formatPrompt(first.text), true);
        answer = recoverFromText(second.text, AnswerSchema);
        finishReason = second.stopReason;
        tokens = second.tokens;
      } catch (error) {
        const steps = session.steps;
        if (error instanceof ModelError) {
          throw new AgentError(`ACP 输出无法解析为结构化结论: ${error.message}`, { steps });
        }
        if (error instanceof AgentError) {
          throw new AgentError(error.message, { steps });
        }
        throw error;
      }
      if (!answer) {
        throw new AgentError('ACP 输出无法解析为结构化结论', { steps: session.steps });
      }
    }
    return {
      answer,
      profile: options.prompt.profile ?? '',
      steps: session.steps,
      tokens,
      text: redactText(first.text),
      finishReason,
    };
  } finally {
    await session.close();
  }
}

export interface AcpRelevanceOptions {
  readonly entry: ModelEntry;
  readonly apiKey: string;
  readonly cwd: string;
  readonly prompt: PromptTemplate;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStderrLine?: (line: string) => void;
}

/**
 * 池中没有 OpenAI 兼容入口时的轻量分类。
 *
 * 与 HTTP 分类保持同一语义：请求成功但回答不可解析返回 `undefined`，
 * 传输/进程错误抛 `ModelError` 交给调用方计罚。
 */
export async function classifyRelevanceWithAcp(
  options: AcpRelevanceOptions,
): Promise<RelevanceVerdict | undefined> {
  const timeoutMs = options.timeoutMs;
  const session = await openAcpSession({
    entry: options.entry,
    apiKey: options.apiKey,
    cwd: options.cwd,
    ...(timeoutMs !== undefined
      ? { softTimeoutMs: timeoutMs, timeoutMs: timeoutMs + KILL_GRACE_MS }
      : {}),
    loopRepeatThreshold: 1,
    ...(options.env ? { env: options.env } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
  });
  try {
    const result = await session.prompt(
      `${promptText(options.prompt)}\n\n只输出一个 JSON 对象，不要调用任何工具。`,
      true,
    );
    return parseRelevanceVerdict(result.text);
  } finally {
    await session.close();
  }
}
