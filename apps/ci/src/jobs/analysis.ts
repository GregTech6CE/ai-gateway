/**
 * analysis：相关性判定 + 代码分析。
 *
 * 权限边界：这个阶段是唯一持有 `MODEL_KEY_*` 的地方，不持有 GitHub 写权限。
 * 模型出口只有 `config/models.json` 里的 baseURL；工具只读工作区，bash 走
 * Zero-Secret 环境（见 `@gt6ce/agent` 的 `run_bash`）。
 *
 * 产物约定：
 * - `outputs/answer.json`：结构化结论（只在 complete 时写）
 * - `outputs/relevance.json`：相关性判定（有结论时写）
 * - `outputs/result.json`：运行结果 + 脱敏扫描结论
 * - `outputs/model_health.json`：本轮更新后的健康状态
 * - `$GITHUB_OUTPUT: scan_upload`：扫描失败时关闭 artifact 闸门
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AgentError,
  ModelError,
  acpCommandAvailable,
  analyzeIssue,
  candidates,
  classifyRelevance,
  classifyRelevanceWithAcp,
  createChatModel,
  createCodeTools,
  loadPool,
  markFailure,
  markSuccess,
  markUsed,
  readHealthFile,
  retryWaitSeconds,
  runAcpAnalysis,
  toModelError,
  writeHealthFile,
  type ModelEntry,
  type ModelFactory,
  type AnalysisStep,
  type RelevanceVerdict,
} from '@gt6ce/agent';
import {
  loadBudgetsConfig,
  loadModelsConfig,
  loadReposConfig,
  redactText,
  resolveRepoConfig,
  type BudgetDefaults,
  type ResolvedRepoConfig,
  type ModelsConfig,
} from '@gt6ce/shared';

import {
  errorMessage,
  isJobEntry,
  logStageDirs,
  modelKeys,
  readJsonFile,
  requireEnv,
  resolveDirs,
  secretValues,
  stageLogger,
  writeGithubOutput,
  writeJsonFile,
  writeTextFile,
  type StageDirs,
} from '../common.ts';
import { buildAnalysisSystem, loadPrompt } from '../prompts.ts';
import {
  mergeScanResults,
  scanJsonPayload,
  scanOutputs,
  type SecretScanResult,
} from '../scan.ts';

/** analysis 只读取这些变量；没有 GitHub 写 token。 */
export interface AnalysisEnv {
  readonly REPO: string;
  readonly ISSUE: string;
  readonly BOT_ENABLED: string;
  readonly MODEL_KEYS: Readonly<Record<string, string>>;
}

export function readAnalysisEnv(source: NodeJS.ProcessEnv = process.env): AnalysisEnv {
  return {
    REPO: requireEnv(source, 'REPO'),
    ISSUE: requireEnv(source, 'ISSUE'),
    BOT_ENABLED: (source.BOT_ENABLED ?? '').trim() || 'true',
    MODEL_KEYS: modelKeys(source),
  };
}

export type AnalysisStatus = 'complete' | 'rejected' | 'failed';

export interface ResultPayload {
  status: AnalysisStatus;
  reason: string;
  steps: number;
  tokens: number;
  elapsed_sec: number;
  attempts: number;
  entry_id: string;
  confidence: string;
  finished_at: string;
  secret_scan?: SecretScanResult;
  [key: string]: unknown;
}

export interface AnalysisOutcome {
  readonly status: AnalysisStatus;
  readonly reason: string;
  readonly result: ResultPayload;
}

interface ModelFile {
  readonly pool?: string;
  readonly analysis_entries?: readonly ModelEntry[];
}

interface SnapshotShape {
  readonly repo?: string;
  readonly issue?: {
    readonly number?: number;
    readonly title?: string;
    readonly body?: string;
    readonly labels?: readonly string[];
  };
  readonly version_tag?: string;
  readonly code_ref?: string;
}

export interface AnalysisOptions {
  readonly env: AnalysisEnv;
  readonly dirs: StageDirs;
  /** 测试注入；默认按 endpoint 建 OpenAI 兼容 provider。 */
  readonly createModel?: ModelFactory;
  readonly now?: Date;
  /** 退避等待注入，测试里避免真的 sleep。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 软着陆预留：硬超时前 2 分钟停止提供工具，让模型用已有证据写结论。
 *
 * 与 `budgets.l2.timeout_minutes` 配合使用——60 分钟的分析实际在 58 分钟开始收尾。
 */
const WRAP_UP_RESERVE_MS = 2 * 60_000;

function issuePrompt(snapshot: SnapshotShape | undefined, repo: string, issue: string): string {
  const versionTag = snapshot?.version_tag ?? '';
  const history = versionTag
    ? `历史版本：code/${versionTag.replaceAll('/', '_').replaceAll(' ', '_')}（${versionTag}），只用于确认问题是否存在或是否已修复。`
    : '历史版本：无（未提供版本号、tag 无效或 worktree 不可用），跳过历史对照。';
  return [
    `目标 issue：${repo}#${issue}`,
    '',
    '工作目录：inputs/、code/、outputs/。只读 inputs/ 与 code/，不要写入任何文件。',
    'code/current 是当前主分支（master），诊断与修复建议以它为准；code/golden 是上游原版的固定提交，是参照实现。',
    history,
    'inputs/code_manifest.json 列出 gt6ce、golden、history、extra 与 auxiliary 的文件路径；先读清单，再按路径读取具体文件。',
    'inputs/logs/ 是已下载并解压的日志与崩溃报告；outputs/log_digest.md 是脱敏后的日志摘要，可先用它定位。',
    '',
    '完成调查后直接返回结构化结论，不要写 answer.md 或 answer.json——结构化输出由执行器负责。',
  ].join('\n');
}

function relevanceInput(snapshot: SnapshotShape | undefined): string {
  const issue = snapshot?.issue;
  if (!issue) {
    return '';
  }
  const parts = [
    `标题：${issue.title ?? ''}`,
    `标签：${(issue.labels ?? []).join(', ')}`,
    `正文：\n${issue.body ?? ''}`,
  ];
  return parts.join('\n\n').slice(0, 12_000);
}

function resultBase(now: Date, started: number): ResultPayload {
  return {
    status: 'failed',
    reason: '',
    steps: 0,
    tokens: 0,
    elapsed_sec: Math.max(0, Math.round((now.getTime() - started) / 100) / 10),
    attempts: 0,
    entry_id: '',
    confidence: '',
    finished_at: now.toISOString(),
  };
}

function normalizeEntries(entries: readonly ModelEntry[] | undefined): ModelEntry[] {
  if (!entries) {
    return [];
  }
  return entries
    .filter((entry) => {
      if (
        typeof entry?.id !== 'string' ||
        typeof entry.model !== 'string' ||
        typeof entry.api_key_env !== 'string'
      ) {
        return false;
      }
      if (entry.driver === 'acp') {
        return typeof entry.acp?.command === 'string' && entry.acp.command !== '';
      }
      return typeof entry.base_url === 'string';
    })
    .map((entry) => ({ ...entry, driver: entry.driver ?? 'openai-compatible' }));
}

/** 主流程。任何分支都经过 `finish`，保证 result.json 与健康状态一定落盘。 */
export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisOutcome> {
  const { env, dirs } = options;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = (options.now ?? new Date()).getTime();
  const secrets = Object.values(env.MODEL_KEYS);
  const log = stageLogger('analysis', secrets);

  const result: ResultPayload = resultBase(options.now ?? new Date(), startedAt);
  let health = readHealthFile(join(dirs.inputs, 'model_health.json'));
  let budgets: BudgetDefaults;
  let models: ModelsConfig;
  let repoCfg: ResolvedRepoConfig;

  const finish = (status: AnalysisStatus, reason: string, extra: Partial<ResultPayload> = {}): AnalysisOutcome => {
    Object.assign(result, extra, {
      status,
      reason: redactText(reason, secrets),
      elapsed_sec:
        Math.round(((options.now ?? new Date()).getTime() - startedAt) / 100) / 10,
      finished_at: (options.now ?? new Date()).toISOString(),
    });
    const outputScan = scanOutputs(dirs.outputs, secrets);
    const payloadScan = scanJsonPayload({ ...result, secret_scan: undefined }, secrets);
    const scan = mergeScanResults(outputScan, payloadScan);
    result.secret_scan = scan;
    writeTextFile(
      join(dirs.outputs, 'result.json'),
      redactText(`${JSON.stringify(result, null, 2)}\n`, secrets),
    );
    writeHealthFile(join(dirs.outputs, 'model_health.json'), health);
    writeGithubOutput({ scan_upload: scan.failed.length > 0 ? 'false' : 'true' });
    log[status === 'failed' ? 'warn' : 'info']('analysis 结束', {
      status,
      reason: result.reason,
      steps: result.steps,
      tokens: result.tokens,
      attempts: result.attempts,
    });
    return { status, reason: result.reason, result };
  };

  mkdirSync(dirs.outputs, { recursive: true });
  mkdirSync(dirs.inputs, { recursive: true });

  try {
    budgets = loadBudgetsConfig(dirs.config).defaults;
    models = loadModelsConfig(dirs.config);
    repoCfg = resolveRepoConfig(loadReposConfig(dirs.config), env.REPO);
  } catch (error) {
    return finish('failed', errorMessage(error));
  }

  if (env.BOT_ENABLED === 'false') {
    return finish('failed', 'BOT_ENABLED=false');
  }
  if (!repoCfg.enabled) {
    return finish('failed', 'repo disabled');
  }

  const modelFile = readJsonFile<ModelFile>(join(dirs.inputs, 'model.json'));
  let pool;
  try {
    pool = loadPool(models, repoCfg.model_pool);
  } catch (error) {
    return finish('failed', errorMessage(error));
  }
  const entries =
    normalizeEntries(modelFile?.analysis_entries).length > 0
      ? normalizeEntries(modelFile?.analysis_entries)
      : candidates(pool, 'analysis', health, {
          env: env.MODEL_KEYS,
          now: options.now,
        });
  if (entries.length === 0) {
    return finish('failed', 'no healthy L2 entry');
  }

  const createModel: ModelFactory =
    options.createModel ??
    ((entry, apiKey) => {
      if (!entry.base_url) {
        throw new ModelError('config', 0, 0, `入口 ${entry.id} 缺少 base_url`);
      }
      return createChatModel({
        baseUrl: entry.base_url,
        apiKey,
        model: entry.model,
        headers: entry.headers,
        providerName: entry.provider,
        supportsStructuredOutputs: entry.structured_outputs,
      });
    });

  const promptSource = { dir: dirs.prompts, profile: repoCfg.prompt_profile };
  let relevancePrompt: string;
  let systemPrompt: string;
  try {
    relevancePrompt = loadPrompt(promptSource, 'relevance');
    systemPrompt = buildAnalysisSystem(promptSource);
  } catch (error) {
    return finish('failed', `提示词加载失败: ${errorMessage(error)}`);
  }
  const snapshot = readJsonFile<SnapshotShape>(join(dirs.inputs, 'snapshot.json'));
  const userPrompt = issuePrompt(snapshot, env.REPO, env.ISSUE);
  const relevanceText = relevanceInput(snapshot);

  const deadline = startedAt + budgets.l2.timeout_minutes * 60_000;
  const now = (): Date => new Date(Math.min(Date.now(), deadline));

  // 分类优先走 OpenAI 兼容入口：轻量分类不值得启动 ACP 会话（会消耗 Vibe 专属额度）。
  // 仅当池中完全没有 OpenAI 兼容入口时，才用 ACP 做一次只读分类。
  const chatEntries = entries.filter(
    (entry) => (entry.driver ?? 'openai-compatible') === 'openai-compatible',
  );
  const acpEntries = entries.filter((entry) => entry.driver === 'acp');
  const failedPreflight = new Set<string>();
  let relevance: RelevanceVerdict | undefined;
  let relevanceEntryId = '';

  for (const entry of chatEntries) {
    const apiKey = env.MODEL_KEYS[entry.api_key_env] ?? '';
    if (!apiKey) {
      markFailure(
        health,
        entry,
        new ModelError('auth', 0, 0, 'missing key'),
        budgets.model_pool,
        now(),
      );
      log.warn('缺少 API key', { entry: entry.id, env: entry.api_key_env });
      failedPreflight.add(entry.id);
      continue;
    }
    if (Date.now() >= deadline) {
      return finish('failed', 'deadline exceeded before preflight');
    }
    if (!entry.base_url) {
      failedPreflight.add(entry.id);
      continue;
    }
    try {
      relevance = await classifyRelevance({
        model: createModel(entry, apiKey),
        prompt: { system: relevancePrompt, user: relevanceText, profile: repoCfg.prompt_profile },
        timeoutMs: budgets.relevance.timeout_seconds * 1000,
        maxOutputTokens: budgets.relevance.max_output_tokens,
      });
    } catch (error) {
      const modelError = toModelError(error);
      markFailure(health, entry, modelError, budgets.model_pool, now());
      log.warn('preflight 失败，换下一个入口', {
        entry: entry.id,
        kind: modelError.kind,
        status: modelError.status,
      });
      relevance = undefined;
      failedPreflight.add(entry.id);
      continue;
    }
    markUsed(health, entry, now());
    relevanceEntryId = entry.id;
    break;
  }

  if (chatEntries.length === 0) {
    for (const entry of acpEntries) {
      const apiKey = env.MODEL_KEYS[entry.api_key_env] ?? '';
      if (!apiKey) {
        markFailure(
          health,
          entry,
          new ModelError('auth', 0, 0, 'missing key'),
          budgets.model_pool,
          now(),
        );
        log.warn('缺少 API key', { entry: entry.id, env: entry.api_key_env });
        failedPreflight.add(entry.id);
        continue;
      }
      if (!acpCommandAvailable(entry, process.env)) {
        markFailure(
          health,
          entry,
          new ModelError('config', 0, 0, `ACP 命令不可用: ${entry.acp?.command ?? ''}`),
          budgets.model_pool,
          now(),
        );
        log.warn('ACP 命令不可用，换下一个入口', { entry: entry.id });
        failedPreflight.add(entry.id);
        continue;
      }
      if (Date.now() >= deadline) {
        return finish('failed', 'deadline exceeded before preflight');
      }
      try {
        relevance = await classifyRelevanceWithAcp({
          entry,
          apiKey,
          cwd: dirs.code,
          prompt: { system: relevancePrompt, user: relevanceText, profile: repoCfg.prompt_profile },
          timeoutMs: budgets.relevance.timeout_seconds * 1000,
          onStderrLine: (line) => log.info('acp stderr', { line }),
        });
      } catch (error) {
        const modelError = toModelError(error);
        markFailure(health, entry, modelError, budgets.model_pool, now());
        log.warn('preflight 失败，换下一个入口', {
          entry: entry.id,
          kind: modelError.kind,
          status: modelError.status,
        });
        relevance = undefined;
        failedPreflight.add(entry.id);
        continue;
      }
      markUsed(health, entry, now());
      relevanceEntryId = entry.id;
      break;
    }
  }

  // 分析入口按池顺序取第一个可用者；ACP 只检查命令可执行，不做 HTTP 探活。
  let chosen: ModelEntry | undefined;
  for (const entry of entries) {
    if (failedPreflight.has(entry.id)) {
      continue;
    }
    const apiKey = env.MODEL_KEYS[entry.api_key_env] ?? '';
    if (!apiKey) {
      markFailure(
        health,
        entry,
        new ModelError('auth', 0, 0, 'missing key'),
        budgets.model_pool,
        now(),
      );
      log.warn('缺少 API key', { entry: entry.id, env: entry.api_key_env });
      failedPreflight.add(entry.id);
      continue;
    }
    if (entry.driver === 'acp') {
      if (!acpCommandAvailable(entry, process.env)) {
        markFailure(
          health,
          entry,
          new ModelError('config', 0, 0, `ACP 命令不可用: ${entry.acp?.command ?? ''}`),
          budgets.model_pool,
          now(),
        );
        log.warn('ACP 命令不可用，换下一个入口', { entry: entry.id });
        failedPreflight.add(entry.id);
        continue;
      }
      markUsed(health, entry, now());
      chosen = entry;
      break;
    }
    if (!entry.base_url) {
      failedPreflight.add(entry.id);
      continue;
    }
    markUsed(health, entry, now());
    chosen = entry;
    break;
  }

  if (!chosen) {
    return finish('failed', 'no endpoint passed preflight');
  }

  if (relevance) {
    const classifiedAt = (options.now ?? new Date()).toISOString();
    const classifiedBy = relevanceEntryId || chosen.id;
    writeJsonFile(join(dirs.outputs, 'relevance.json'), {
      ...relevance,
      entry_id: classifiedBy,
      classified_at: classifiedAt,
    });
    log.info('相关性分类', {
      category: relevance.relevance,
      confidence: relevance.confidence,
      entry: classifiedBy,
    });
    const only = new Set(repoCfg.reject.only.map((item) => item.toLowerCase()));
    if (only.has(relevance.relevance) && relevance.confidence >= repoCfg.reject.min_confidence) {
      return finish(
        'rejected',
        `relevance ${relevance.relevance} confidence=${relevance.confidence.toFixed(2)}`,
        {
          entry_id: classifiedBy,
          confidence: String(relevance.confidence),
          relevance: relevance.relevance,
        },
      );
    }
  }

  const tools = createCodeTools({ root: dirs.root });
  const httpMaxRetries = budgets.model_pool.rate_limit_retries;
  const acpMaxRetries = budgets.model_pool.acp_retries;
  const startIndex = entries.indexOf(chosen);
  let lastError: string = 'no attempt';
  let lastErrorDetail = '';
  let lastEntryId = '';
  let lastSteps = 0;
  let lastTokens = 0;

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const apiKey = env.MODEL_KEYS[entry.api_key_env] ?? '';
    if (!apiKey) {
      continue;
    }
    let retries = 0;
    let switchEntry = false;
    // ACP 整会话重跑代价高，同入口重试与 HTTP 的 rate_limit_retries 解耦。
    const maxRetries = entry.driver === 'acp' ? acpMaxRetries : httpMaxRetries;

    while (true) {
      if (Date.now() >= deadline) {
        return finish('failed', 'deadline exceeded', {
          attempts: result.attempts,
          entry_id: lastEntryId || entry.id,
          steps: lastSteps,
          tokens: lastTokens,
          ...(lastErrorDetail ? { error_detail: lastErrorDetail } : {}),
        });
      }
      result.attempts += 1;
      markUsed(health, entry, now());
      try {
        const prompt = {
          system: systemPrompt,
          user: userPrompt,
          profile: repoCfg.prompt_profile,
        };
        // ACP 会话的 cwd 固定为 code/；inputs/ 与 outputs/ 作为附加工作区加入，
        // 并在提示里说明两者的位置，避免按相对路径找不到。
        const acpPrompt = {
          ...prompt,
          user: `${userPrompt}\n\nACP 会话说明：当前工作目录是 code/（其中 current 指向主分支工作树），golden 与历史版本也在此目录下；inputs/ 与 outputs/ 不在工作目录下，其绝对路径分别为 ${dirs.inputs}、${dirs.outputs}，已作为附加工作区加入会话。\n检索要求：不要调用 bash 或其他命令执行工具；先用 inputs/code_manifest.json 与 outputs/log_digest.md 定位，再使用 read_file 的 offset/limit 只读取必要片段，避免重复读取整文件。`,
        };
        const onStep = (step: AnalysisStep): void => {
          log.info('agent step', {
            index: step.index,
            toolCalls: step.toolCalls.map((call) => call.name).join(','),
          });
        };
        const timeoutMs = Math.max(5_000, deadline - Date.now());
        // 软截止比硬超时早 2 分钟：到点后禁用工具，给模型留出写结论的时间，
        // 避免像以前那样撞步数上限、最后一步只有工具调用而没有正文。
        const softTimeoutMs = Math.max(5_000, deadline - Date.now() - WRAP_UP_RESERVE_MS);
        const outcome =
          entry.driver === 'acp'
            ? await runAcpAnalysis({
                entry,
                apiKey,
                prompt: acpPrompt,
                cwd: dirs.code,
                additionalDirectories: [dirs.inputs, dirs.outputs],
                timeoutMs,
                softTimeoutMs,
                loopRepeatThreshold: budgets.l2.loop_repeat_threshold,
                onStep,
                onStderrLine: (line) => log.info('acp stderr', { line }),
              })
            : await analyzeIssue({
                model: createModel(entry, apiKey),
                prompt,
                tools,
                timeoutMs,
                softTimeoutMs,
                loopRepeatThreshold: budgets.l2.loop_repeat_threshold,
                temperature: 0,
                onStep,
              });
        markSuccess(health, entry, now());
        writeJsonFile(join(dirs.outputs, 'answer.json'), outcome.answer);
        return finish('complete', 'accepted', {
          steps: outcome.steps,
          tokens: outcome.tokens.total,
          entry_id: entry.id,
          confidence: outcome.answer.confidence,
          profile: outcome.profile,
          finish_reason: outcome.finishReason,
        });
      } catch (error) {
        if (error instanceof AgentError) {
          // 契约未满足不是传输故障：不换入口也不重试，直接以失败收尾。
          // steps/tokens 来自错误自身：失败前已经跑过的调查要如实记录，不能写 0。
          lastError = error.message;
          return finish('failed', lastError, {
            steps: error.steps ?? 0,
            tokens: error.tokens ?? 0,
            entry_id: entry.id,
            attempts: result.attempts,
          });
        }
        const modelError = toModelError(error);
        markFailure(health, entry, modelError, budgets.model_pool, now());
        const errorDetail = redactText(modelError.detail, secrets).slice(0, 500);
        lastErrorDetail = errorDetail;
        lastEntryId = entry.id;
        if (modelError.steps !== undefined) {
          lastSteps = modelError.steps;
        }
        if (modelError.tokens !== undefined) {
          lastTokens = modelError.tokens;
        }
        lastError = `${modelError.kind}${modelError.status ? ` ${modelError.status}` : ''}`;
        log.warn('模型调用失败', {
          entry: entry.id,
          kind: modelError.kind,
          status: modelError.status,
          retry: retries,
          detail: errorDetail,
        });

        if (modelError.kind === 'auth' || modelError.kind === 'config') {
          switchEntry = true;
          break;
        }
        const retryable =
          modelError.kind === 'rate' ||
          modelError.kind === 'upstream' ||
          modelError.kind === 'network';
        if (retryable && retries < maxRetries) {
          const waitSeconds = retryWaitSeconds(modelError, budgets.model_pool);
          if (deadline - Date.now() > waitSeconds * 1000 + 120_000) {
            retries += 1;
            log.info('退避等待', { entry: entry.id, wait: waitSeconds, retry: retries });
            await sleep(waitSeconds * 1000);
            continue;
          }
        }
        // 单入口重试耗尽或剩余时间不足以退避：切换下一个候选，而不是直接失败。
        switchEntry = true;
        break;
      }
    }

    if (!switchEntry) {
      break;
    }
    log.warn('入口不可用，切换到下一个', { entry: entry.id });
  }

  return finish('failed', lastError, {
    attempts: result.attempts,
    ...(lastEntryId ? { entry_id: lastEntryId } : {}),
    steps: lastSteps,
    tokens: lastTokens,
    ...(lastErrorDetail ? { error_detail: lastErrorDetail } : {}),
  });
}

export async function main(): Promise<void> {
  const env = readAnalysisEnv();
  const dirs = resolveDirs();
  logStageDirs('analysis', dirs);
  const secrets = secretValues(process.env, Object.keys(env.MODEL_KEYS));
  if (secrets.length === 0) {
    process.stderr.write('warning: 没有任何 MODEL_KEY_* 可用\n');
  }
  const outcome = await runAnalysis({ env, dirs });
  if (outcome.status === 'failed') {
    process.exitCode = 1;
  }
}

if (isJobEntry('analysis')) {
  await main();
}
