/**
 * 后端服务的轻量 REST 客户端。
 *
 * QQ 机器人不持有 LLM 与 GitHub 凭据：分析交给 agent-svc，写回交给 github-writer。
 * 两个客户端都用原生 `fetch`，`fetchImpl` 可注入以便测试；每次请求都带独立的
 * `Authorization: Bearer <token>`，token 由配置提供，不从环境变量读取。
 *
 * 所有响应都过 Zod 校验：后端返回结构漂移时在这里失败，而不是在业务代码里
 * 变成 `undefined` 继续往下跑。
 */
import {
  AgentTaskRequestSchema,
  AgentTaskSnapshotSchema,
  CreateIssueRequestSchema,
  CreatedIssueSchema,
  TaskAcceptedSchema,
  type AgentTaskRequest,
  type AgentTaskSnapshot,
  type CreateIssueRequest,
  type CreatedIssue,
  type IssueDraft,
} from '@gt6ce/shared';
import { z } from 'zod';

/**
 * 契约的唯一来源是 `@gt6ce/shared`。这里重新导出，保持 `@gt6ce/qqbot-app` 既有的
 * 导入路径不变；三端共用同一份 schema，字段不会各自漂移。
 */
export {
  AgentTaskRequestSchema,
  AgentTaskSnapshotSchema,
  CreateIssueRequestSchema,
  CreatedIssueSchema,
  IssueDraftInputSchema,
  IssueDraftSchema,
  TaskAcceptedSchema,
} from '@gt6ce/shared';
export type {
  AgentTaskRequest,
  AgentTaskSnapshot,
  CreateIssueRequest,
  CreatedIssue,
  IssueDraft,
  IssueDraftInput,
} from '@gt6ce/shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 后端返回非 2xx、网络失败或响应不符合契约时抛出。 */
export class RpcError extends Error {
  /** HTTP 状态码；`0` 表示请求没有拿到响应。 */
  readonly status: number;

  readonly endpoint: string;

  readonly path: string;

  readonly detail: string;

  constructor(init: { status: number; endpoint: string; path: string; detail: string }) {
    super(`RPC ${init.path} -> ${init.status === 0 ? 'network' : init.status}: ${init.detail}`);
    this.name = 'RpcError';
    this.status = init.status;
    this.endpoint = init.endpoint;
    this.path = init.path;
    this.detail = init.detail;
  }
}

/** 分析任务失败或超时。 */
export class RpcTaskError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.name = 'RpcTaskError';
    this.taskId = taskId;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

function joinUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, '')}${path}`;
}

function clip(text: string, limit = 500): string {
  const value = text.trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

interface RequestOptions {
  readonly fetchImpl: FetchLike;
  readonly endpoint: string;
  readonly token: string;
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly timeoutMs: number;
}

/**
 * 只取 `safeParse` 的输出类型：Zod 的输入类型会因为 `.default()` 而比输出更宽，
 * 直接用 `z.ZodType<T>` 会把泛型推断成输入类型。
 */
interface ResponseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: z.ZodError };
}

async function requestJson<T>(options: RequestOptions, schema: ResponseSchema<T>): Promise<T> {
  const url = joinUrl(options.endpoint, options.path);
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new RpcError({
      status: 0,
      endpoint: options.endpoint,
      path: options.path,
      detail: `请求失败: ${errorMessage(error)}`,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new RpcError({
      status: response.status,
      endpoint: options.endpoint,
      path: options.path,
      detail: clip(text),
    });
  }
  if (text.trim() === '') {
    throw new RpcError({
      status: response.status,
      endpoint: options.endpoint,
      path: options.path,
      detail: '响应为空',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RpcError({
      status: response.status,
      endpoint: options.endpoint,
      path: options.path,
      detail: '响应不是合法 JSON',
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new RpcError({
      status: response.status,
      endpoint: options.endpoint,
      path: options.path,
      detail: `响应不符合契约: ${describeIssues(result.error)}`,
    });
  }
  return result.data;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface AgentRpcClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export interface WaitOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  /** 测试注入：避免真的等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * 分析服务的抽象。
 *
 * Handler 只依赖这两个方法，测试因此可以注入内存实现，不必起 HTTP 服务。
 */
export interface AgentGateway {
  submit(request: AgentTaskRequest): Promise<{ taskId: string }>;
  wait(taskId: string, options?: WaitOptions): Promise<IssueDraft>;
}

export class AgentRpcClient implements AgentGateway {
  private readonly endpoint: string;

  private readonly token: string;

  private readonly fetchImpl: FetchLike;

  private readonly timeoutMs: number;

  constructor(options: AgentRpcClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 提交分析任务，立即拿到 `taskId`。 */
  async submit(request: AgentTaskRequest): Promise<{ taskId: string }> {
    const body = AgentTaskRequestSchema.parse(request);
    return requestJson(
      {
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        token: this.token,
        path: '/tasks',
        method: 'POST',
        body,
        timeoutMs: this.timeoutMs,
      },
      TaskAcceptedSchema,
    );
  }

  /** 查询任务状态。 */
  async status(taskId: string): Promise<AgentTaskSnapshot> {
    return requestJson(
      {
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        token: this.token,
        path: `/tasks/${encodeURIComponent(taskId)}`,
        method: 'GET',
        timeoutMs: this.timeoutMs,
      },
      AgentTaskSnapshotSchema,
    );
  }

  /** 轮询直到成功、失败或超时。 */
  async wait(taskId: string, options: WaitOptions = {}): Promise<IssueDraft> {
    const intervalMs = options.intervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 180_000;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const deadline = now() + timeoutMs;

    for (;;) {
      const snapshot = await this.status(taskId);
      if (snapshot.status === 'succeeded') {
        if (!snapshot.result) {
          throw new RpcTaskError(taskId, '任务已完成但没有返回草稿');
        }
        return snapshot.result;
      }
      if (snapshot.status === 'failed') {
        throw new RpcTaskError(taskId, snapshot.error ?? '任务失败，未提供原因');
      }
      if (now() >= deadline) {
        throw new RpcTaskError(taskId, '等待分析结果超时');
      }
      await sleep(intervalMs);
    }
  }
}

export interface GitHubWriterRpcClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** 写回服务的抽象。 */
export interface IssueWriter {
  createIssue(request: CreateIssueRequest): Promise<CreatedIssue>;
}

export class GitHubWriterRpcClient implements IssueWriter {
  private readonly endpoint: string;

  private readonly token: string;

  private readonly fetchImpl: FetchLike;

  private readonly timeoutMs: number;

  constructor(options: GitHubWriterRpcClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 创建 Issue；`requestId` 作为幂等键。 */
  async createIssue(request: CreateIssueRequest): Promise<CreatedIssue> {
    const body = CreateIssueRequestSchema.parse(request);
    return requestJson(
      {
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        token: this.token,
        path: '/issues',
        method: 'POST',
        body,
        timeoutMs: this.timeoutMs,
      },
      CreatedIssueSchema,
    );
  }
}
