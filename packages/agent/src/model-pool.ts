/**
 * 模型池：endpoint 是健康单位，role 只是绑定。
 *
 * 与 Python 版的差别只有一处语义变化：调度与退避不再负责发请求，请求交给 Vercel AI SDK。
 * 因此这里移除 `chat` / `failover_chat` / `select` 这类内嵌 HTTP 的死代码，只保留
 * 「哪些入口可用、按什么顺序尝试、失败后冷却多久」。
 *
 * 约束：不在模块顶层读环境变量。健康状态由调用方传入，API key 由 `apiKeyFor` 从
 * 显式传入的 env 读取，便于测试与权限隔离。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import type {
  ModelBinding,
  ModelEndpoint,
  ModelPool,
  ModelPoolBudget,
  ModelsConfig,
} from '@gt6ce/shared';

import { isStructuredOutputError } from './output-errors.ts';

/** 待机时长上限：超过一个月按一个月计，从未使用过的取同值。 */
export const MAX_IDLE_SECONDS = 30 * 24 * 60 * 60;

export type ModelErrorKind = 'auth' | 'rate' | 'config' | 'upstream' | 'network' | 'unavailable';

/** 可判定的模型调用错误；`status` 与 `retryAfterSeconds` 供退避与切换使用。 */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number;
  readonly retryAfterSeconds: number;
  readonly detail: string;
  /** 失败前已完成的工具步数；ACP 会话才有。 */
  readonly steps?: number;
  /** 失败前已消耗的 token；有上报时才有。 */
  readonly tokens?: number;

  constructor(
    kind: ModelErrorKind,
    status = 0,
    retryAfterSeconds = 0,
    detail = '',
    stats: { readonly steps?: number; readonly tokens?: number } = {},
  ) {
    super(`${kind} status=${status} ${detail}`.slice(0, 300));
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
    if (stats.steps !== undefined) {
      this.steps = stats.steps;
    }
    if (stats.tokens !== undefined) {
      this.tokens = stats.tokens;
    }
  }
}

/** 绑定后的入口：endpoint 字段 + role 上的调度参数。 */
export interface ModelEntry extends ModelEndpoint {
  readonly role: string;
  readonly weight: number;
  readonly context?: number;
  readonly effort?: string;
}

export interface EndpointHealth {
  status?: 'ok' | 'cooldown' | 'disabled';
  failures?: number;
  early_failures?: number;
  late_failures?: number;
  until?: string;
  reason?: string;
  updated_at?: string;
  last_used_at?: string;
}

export interface ModelHealthState {
  endpoints: Record<string, EndpointHealth>;
}

export function emptyHealthState(): ModelHealthState {
  return { endpoints: {} };
}

function iso(value: Date): string {
  return value.toISOString();
}

function parseTime(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * 读取健康状态文件；不存在或不可解析时返回空状态。
 *
 * 健康状态是跨 run 的提示，损坏时按「没有历史」处理比让整次分析失败更合理——
 * 真正的失败由入口调用本身暴露。
 */
export function readHealthFile(path: string): ModelHealthState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyHealthState();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'endpoints' in parsed) {
      const endpoints = (parsed as { endpoints?: unknown }).endpoints;
      if (endpoints && typeof endpoints === 'object') {
        return { endpoints: endpoints as Record<string, EndpointHealth> };
      }
    }
  } catch {
    // 落到空状态
  }
  return emptyHealthState();
}

export function writeHealthFile(path: string, state: ModelHealthState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 从仓库变量里取健康状态；非法 JSON 视为空。 */
export function parseHealth(value: string | undefined): ModelHealthState {
  if (!value || !value.trim()) {
    return emptyHealthState();
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && 'endpoints' in parsed) {
      const endpoints = (parsed as { endpoints?: unknown }).endpoints;
      if (endpoints && typeof endpoints === 'object') {
        return { endpoints: endpoints as Record<string, EndpointHealth> };
      }
    }
  } catch {
    // 忽略损坏值
  }
  return emptyHealthState();
}

export function loadPool(config: ModelsConfig, name: string): ModelPool {
  const pool = config.pools[name];
  if (!pool) {
    throw new ModelError('config', 0, 0, `未知模型池: ${name}`);
  }
  return pool;
}

function weightOf(binding: ModelBinding): number {
  const weight = binding.weight ?? 1;
  return Number.isFinite(weight) ? Math.max(0, Math.trunc(weight)) : 1;
}

/**
 * 把 role 绑定与 endpoint 合并；id 保持 endpoint id，用作健康状态的键。
 * 绑定排序固定为「权重降序 + id 升序」，保证同权重下顺序稳定。
 */
export function bindings(pool: ModelPool, role: string): ModelEntry[] {
  const enabled = new Map<string, ModelEndpoint>();
  for (const endpoint of pool.endpoints) {
    if (endpoint.enabled) {
      enabled.set(endpoint.id, endpoint);
    }
  }
  const result: ModelEntry[] = [];
  for (const binding of pool.roles[role] ?? []) {
    const endpoint = enabled.get(binding.endpoint);
    if (!endpoint) {
      continue;
    }
    const entry: ModelEntry = {
      ...endpoint,
      role,
      weight: weightOf(binding),
      headers: { ...endpoint.headers },
      ...(binding.context !== undefined ? { context: binding.context } : {}),
      ...(binding.effort !== undefined ? { effort: binding.effort } : {}),
    };
    result.push(entry);
  }
  result.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  return result;
}

function endpointState(state: ModelHealthState, id: string): EndpointHealth {
  const existing = state.endpoints[id];
  if (existing) {
    return existing;
  }
  const created: EndpointHealth = {};
  state.endpoints[id] = created;
  return created;
}

/** 冷却结束或从未冷却即视为可用；过期的 until 会被就地清掉。 */
export function isAvailable(
  entry: ModelEntry,
  state: ModelHealthState,
  now: Date = new Date(),
): boolean {
  const item = endpointState(state, entry.id);
  if (item.status === 'cooldown' || item.status === 'disabled') {
    const until = parseTime(item.until);
    if (until && until.getTime() > now.getTime()) {
      return false;
    }
    item.status = 'ok';
    delete item.until;
  }
  return true;
}

export function apiKeyFor(
  entry: ModelEntry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[entry.api_key_env] ?? '';
}

export function markSuccess(
  state: ModelHealthState,
  entry: ModelEntry,
  now: Date = new Date(),
): void {
  const item = endpointState(state, entry.id);
  item.status = 'ok';
  item.failures = 0;
  item.early_failures = 0;
  item.late_failures = 0;
  item.updated_at = iso(now);
  delete item.until;
  delete item.reason;
}

/** 记录最后一次被选中，供下一轮按最久未用优先调度。 */
export function markUsed(
  state: ModelHealthState,
  entry: ModelEntry,
  now: Date = new Date(),
): void {
  endpointState(state, entry.id).last_used_at = iso(now);
}

function bucketOf(kind: ModelErrorKind): 'early' | 'late' {
  return kind === 'auth' || kind === 'config' ? 'early' : 'late';
}

/**
 * 只标记 endpoint：早期（auth/config）与晚期（rate/upstream/network）分别累计，
 * 退避按 `base × 2^(n-1)` 增长并封顶，成功时清零。
 *
 * 晚期错误带有 `Retry-After` 时抬升基数，避免服务端要求的等待被本地下限吃掉。
 */
export function markFailure(
  state: ModelHealthState,
  entry: ModelEntry,
  error: ModelError,
  budget: ModelPoolBudget,
  now: Date = new Date(),
): void {
  const item = endpointState(state, entry.id);
  const bucket = bucketOf(error.kind);
  const counterKey = bucket === 'early' ? 'early_failures' : 'late_failures';
  const counter = (item[counterKey] ?? 0) + 1;
  item[counterKey] = counter;
  item.failures = (item.failures ?? 0) + 1;
  item.reason = error.kind;
  item.updated_at = iso(now);

  const baseMinutes =
    bucket === 'early' ? budget.early_base_minutes : budget.late_base_minutes;
  const capMinutes = bucket === 'early' ? budget.early_max_minutes : budget.late_max_minutes;
  let base = baseMinutes;
  if (bucket === 'late' && error.retryAfterSeconds > 0) {
    base = Math.max(base, error.retryAfterSeconds / 60);
  }
  const minutes = Math.min(capMinutes, base * 2 ** (counter - 1));
  item.status = minutes >= capMinutes ? 'disabled' : 'cooldown';
  item.until = iso(new Date(now.getTime() + minutes * 60_000));
}

function idleSeconds(entry: ModelEntry, state: ModelHealthState, now: Date): number {
  const used = parseTime(endpointState(state, entry.id).last_used_at);
  if (!used) {
    return MAX_IDLE_SECONDS;
  }
  const elapsed = (now.getTime() - used.getTime()) / 1000;
  return Math.min(MAX_IDLE_SECONDS, Math.max(0, elapsed));
}

/**
 * 按 `权重 × 待机时长` 从高到低排序，作为带权的最久未用调度。
 *
 * 选中即刷新 `last_used_at`（由调用方 `markUsed`），长期选择次数趋于权重之比：
 * 权重翻倍的效果是间隔减半，而不是永久优先。
 */
export function candidates(
  pool: ModelPool,
  role: string,
  state: ModelHealthState,
  options: { readonly requireKey?: boolean; readonly env?: NodeJS.ProcessEnv; readonly now?: Date } = {},
): ModelEntry[] {
  const requireKey = options.requireKey ?? true;
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const items = bindings(pool, role).filter(
    (entry) => isAvailable(entry, state, now) && (!requireKey || apiKeyFor(entry, env) !== ''),
  );
  items.sort((a, b) => {
    const scoreA = a.weight * idleSeconds(a, state, now);
    const scoreB = b.weight * idleSeconds(b, state, now);
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    if (b.weight !== a.weight) {
      return b.weight - a.weight;
    }
    return a.id.localeCompare(b.id);
  });
  return items;
}

/** 429/5xx 的单次等待：服务端要求的秒数与本地区间取交。 */
export function retryWaitSeconds(error: ModelError, budget: ModelPoolBudget): number {
  const raw = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : budget.rate_limit_wait_seconds;
  const lower = Math.max(raw, budget.rate_limit_min_wait_seconds);
  return Math.min(lower, budget.rate_limit_max_wait_seconds);
}

/** 把任意异常收敛成可判定的 `ModelError`；已是的原样返回。 */
export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  const status = statusOf(error);
  const retryAfterSeconds = retryAfterOf(error);
  const detail = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) {
    return new ModelError('auth', status, retryAfterSeconds, detail);
  }
  if (status === 429) {
    return new ModelError('rate', status, retryAfterSeconds, detail);
  }
  if (status === 400 || status === 404) {
    return new ModelError('config', status, retryAfterSeconds, detail);
  }
  if (status !== undefined && status >= 500) {
    return new ModelError('upstream', status, retryAfterSeconds, detail);
  }
  if (status !== undefined) {
    return new ModelError('upstream', status, retryAfterSeconds, detail);
  }
  // 结构化输出失败（模型没按 schema 作答）没有 statusCode，但请求本身是成功的：
  // 归为 config 而非 network，避免按网络故障做 60s 退避；调用方会直接切换入口。
  // `analyzeIssue` / `draftIssue` 已先行拦截并抛 AgentError，这里是给未来新增调用点的兜底。
  if (isStructuredOutputError(error)) {
    return new ModelError('config', 0, retryAfterSeconds, detail);
  }
  // 本地文件系统错误不是网络故障：按 config 处理，调用方会直接切换入口而不是同入口重试。
  const fsCode = fsErrorCodeOf(error);
  if (fsCode !== undefined && FS_ERROR_CODES.has(fsCode)) {
    return new ModelError('config', 0, 0, detail);
  }
  return new ModelError('network', 0, retryAfterSeconds, detail);
}

/** 本地文件系统错误码：与网络故障区分，统一归为 config。 */
export const FS_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOSPC',
  'EROFS',
  'ENOTDIR',
  'EISDIR',
]);

function fsErrorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

interface ApiErrorLike {
  readonly statusCode?: number;
  readonly responseHeaders?: Record<string, string>;
}

function asApiError(error: unknown): ApiErrorLike | undefined {
  return error && typeof error === 'object' && 'statusCode' in error
    ? (error as ApiErrorLike)
    : undefined;
}

function statusOf(error: unknown): number | undefined {
  const apiError = asApiError(error);
  if (apiError && typeof apiError.statusCode === 'number') {
    return apiError.statusCode;
  }
  return undefined;
}

function retryAfterOf(error: unknown): number {
  const headers = asApiError(error)?.responseHeaders;
  if (!headers) {
    return 0;
  }
  const value = headers['retry-after'] ?? headers['Retry-After'];
  if (!value) {
    return 0;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
