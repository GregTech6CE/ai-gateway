/**
 * 轻量 GitHub REST 客户端。
 *
 * 只做三件事：拼请求、判状态码、解 JSON。非 2xx 一律抛 `GitHubApiError`，
 * 调用方按 `status` 分支（例如占位评论消失时的 404/410 回退），不解析错误文本。
 *
 * `token` / `fetch` 全部由参数注入：本模块不读环境变量，也不在导入时建立任何连接。
 */
import { GitHubApiError } from '@gt6ce/shared';

export const GITHUB_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_USER_AGENT = 'gt6ce-ai-gateway';
const DETAIL_LIMIT = 400;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubRequestOptions {
  readonly token?: string;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
}

export interface GitHubRequestParams extends GitHubRequestOptions {
  readonly body?: unknown;
}

export interface GitHubPageOptions {
  readonly maxPages?: number;
}

/** 分页与单次请求的公共面，便于在测试里替换成内存实现。 */
export interface GitHubApi {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  paginate<T>(path: string, options?: GitHubPageOptions): Promise<T[]>;
}

function absoluteUrl(path: string, baseUrl: string): string {
  return path.startsWith('http://') || path.startsWith('https://') ? path : `${baseUrl}${path}`;
}

/**
 * 发一次请求。
 *
 * 空响应体（204 或 `DELETE` 的常见返回）解析为 `undefined`；2xx 但 JSON 非法视为
 * 协议错误，同样抛 `GitHubApiError`，以免调用方拿到半个对象继续执行。
 */
export async function ghRequest<T>(
  method: string,
  path: string,
  params: GitHubRequestParams = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': params.userAgent ?? DEFAULT_USER_AGENT,
    'Content-Type': 'application/json',
  };
  if (params.token) {
    headers.Authorization = `Bearer ${params.token}`;
  }

  const init: RequestInit = { method, headers };
  if (params.body !== undefined) {
    init.body = JSON.stringify(params.body);
  }
  if (params.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(params.timeoutMs);
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(
    absoluteUrl(path, params.baseUrl ?? GITHUB_API_BASE),
    init,
  );
  const text = await response.text();

  if (!response.ok) {
    throw new GitHubApiError({
      status: response.status,
      method,
      path,
      detail: text.slice(0, DETAIL_LIMIT),
    });
  }
  if (text === '') {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GitHubApiError({
      status: response.status,
      method,
      path,
      detail: `响应不是合法 JSON: ${reason}`,
    });
  }
}

/**
 * 逐页取列表，直到不足 100 条或达到 `maxPages`。
 *
 * 上限是防御性的：评论、标签这类列表正常不会超过几页，没有上限时一个异常响应
 * 就可能把运行拖到超时。
 */
export async function paginate<T>(
  path: string,
  params: GitHubRequestOptions & GitHubPageOptions = {},
): Promise<T[]> {
  const maxPages = params.maxPages ?? 10;
  const separator = path.includes('?') ? '&' : '?';
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const chunk = await ghRequest<T[] | undefined>(
      'GET',
      `${path}${separator}per_page=100&page=${page}`,
      params,
    );
    if (!Array.isArray(chunk) || chunk.length === 0) {
      break;
    }
    items.push(...chunk);
    if (chunk.length < 100) {
      break;
    }
  }
  return items;
}

/**
 * bot 身份比对。
 *
 * App 安装身份的 login 形如 `name[bot]`，而个别事件给出的 `type` 与 login 后缀
 * 并不总是一致，因此同时接受精确匹配与「Bot 类型 + 前缀匹配」。
 */
export function botLoginMatches(
  user: { readonly login?: string; readonly type?: string } | null | undefined,
  expectedLogin: string,
): boolean {
  const login = user?.login ?? '';
  if (login === expectedLogin) {
    return true;
  }
  const base = expectedLogin.split('[')[0] ?? '';
  return user?.type === 'Bot' && base.length > 0 && login.startsWith(base);
}

/** 绑定固定 token / fetch 的客户端，供需要多次调用的流程复用。 */
export class GitHubClient implements GitHubApi {
  private readonly options: GitHubRequestOptions;

  constructor(options: GitHubRequestOptions = {}) {
    this.options = options;
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return ghRequest<T>(method, path, { ...this.options, body });
  }

  paginate<T>(path: string, options: GitHubPageOptions = {}): Promise<T[]> {
    return paginate<T>(path, { ...this.options, maxPages: options.maxPages });
  }
}
