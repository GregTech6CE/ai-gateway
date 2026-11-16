/**
 * 写回服务的业务层：白名单 → 凭据扫描 → 标签清洗 → 建 Issue。
 *
 * 顺序是刻意的：先拒绝未授权仓库，再扫描内容，最后才换取 GitHub token——被拦截的请求
 * 不会触发任何 GitHub 调用，也不会消耗 App 的安装令牌。
 */
import {
  GitHubClient,
  UNKNOWN_TYPE,
  sanitize,
  typeValues,
  type FetchLike,
} from '@gt6ce/github';
import {
  GitHubApiError,
  resolveRepoConfig,
  scanText,
  type Logger,
  type ReposConfig,
  type ResolvedRepoConfig,
} from '@gt6ce/shared';
import { z } from 'zod';

import type { CreateIssueOutcome, CreateIssueRequest, CreatedIssue } from './contracts.ts';
import { GitHubAuthError, type TokenProvider } from './github-auth.ts';
import type { IdempotencyCache } from './idempotency.ts';

const GitHubIssueResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
});

/** 服务层可预期的失败；`status` 直接作为响应码。 */
export class IssueServiceError extends Error {
  readonly status: number;

  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'IssueServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface IssueServiceDeps {
  readonly repos: ReposConfig;
  readonly tokenProvider: TokenProvider;
  readonly idempotency: IdempotencyCache;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class IssueService {
  private readonly deps: IssueServiceDeps;

  /** 同一 requestId 的并发请求合并成一次 GitHub 调用。 */
  private readonly inflight = new Map<string, Promise<CreatedIssue>>();

  constructor(deps: IssueServiceDeps) {
    this.deps = deps;
  }

  async create(request: CreateIssueRequest): Promise<CreateIssueOutcome> {
    const cached = this.deps.idempotency.get(request.requestId);
    if (cached) {
      return { issue: cached, replayed: true };
    }
    const running = this.inflight.get(request.requestId);
    if (running) {
      return { issue: await running, replayed: true };
    }

    const promise = this.doCreate(request);
    this.inflight.set(request.requestId, promise);
    try {
      const issue = await promise;
      this.deps.idempotency.set(request.requestId, issue);
      return { issue, replayed: false };
    } finally {
      this.inflight.delete(request.requestId);
    }
  }

  private async doCreate(request: CreateIssueRequest): Promise<CreatedIssue> {
    const repo = this.resolveRepo(request.repo);

    const hits = scanText([request.title, request.body, ...request.labels].join('\n'));
    if (hits.length > 0) {
      this.deps.logger.warn('内容命中凭据扫描，拒绝写回', {
        repo: repo.key,
        requestId: request.requestId,
        hits: hits.length,
      });
      throw new IssueServiceError(422, '内容包含敏感凭据', 'sensitive_content');
    }

    const labels = resolveLabels(repo, request.labels);
    const token = await this.tokenProvider(repo, request.requestId);
    const client = new GitHubClient({
      token,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.baseUrl ? { baseUrl: this.deps.baseUrl } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    });

    try {
      return await this.post(client, repo.key, request, labels);
    } catch (error) {
      // 标签在仓库里不存在时 GitHub 返回 422。Issue 本体仍然可以创建：去掉标签重试一次，
      // 比让整次写回失败更符合用户预期，同时记一条 warn 供运维补标签。
      if (error instanceof GitHubApiError && error.status === 422 && labels.length > 0) {
        this.deps.logger.warn('标签被 GitHub 拒绝，去掉标签重试', {
          repo: repo.key,
          requestId: request.requestId,
          labels,
        });
        try {
          return await this.post(client, repo.key, request, []);
        } catch (retryError) {
          throw mapGitHubError(retryError);
        }
      }
      throw mapGitHubError(error);
    }
  }

  private resolveRepo(repo: string): ResolvedRepoConfig {
    let resolved: ResolvedRepoConfig;
    try {
      resolved = resolveRepoConfig(this.deps.repos, repo);
    } catch {
      throw new IssueServiceError(403, '仓库未授权', 'repo_forbidden');
    }
    if (!resolved.enabled) {
      throw new IssueServiceError(403, '仓库未启用', 'repo_disabled');
    }
    return resolved;
  }

  private async tokenProvider(repo: ResolvedRepoConfig, requestId: string): Promise<string> {
    try {
      return await this.deps.tokenProvider.tokenFor(repo.key);
    } catch (error) {
      this.deps.logger.error('获取 GitHub token 失败', {
        repo: repo.key,
        requestId,
        error,
      });
      if (error instanceof GitHubAuthError) {
        throw new IssueServiceError(502, 'GitHub 认证失败', 'github_auth');
      }
      throw error;
    }
  }

  private async post(
    client: GitHubClient,
    repo: string,
    request: CreateIssueRequest,
    labels: readonly string[],
  ): Promise<CreatedIssue> {
    const response = await client.request<unknown>('POST', `/repos/${repo}/issues`, {
      title: request.title,
      body: request.body,
      ...(labels.length > 0 ? { labels } : {}),
    });
    const parsed = GitHubIssueResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new IssueServiceError(502, 'GitHub 返回不符合契约', 'github_invalid_response');
    }
    return { number: parsed.data.number, url: parsed.data.html_url };
  }
}

/** 把 GitHub 传输错误映射成稳定的 502；其他错误原样抛出。 */
function mapGitHubError(error: unknown): unknown {
  if (error instanceof GitHubApiError) {
    return new IssueServiceError(502, `GitHub 返回 HTTP ${error.status}`, 'github_error');
  }
  return error;
}

/**
 * 标签清洗：六轴门禁 + 类型回填。
 *
 * `sanitize` 会把类型标签从 `labels` 里摘出来单独返回 `issueType`，所以最后要把它加回去。
 */
export function resolveLabels(
  repo: ResolvedRepoConfig,
  labels: readonly string[],
): string[] {
  const normalized = labels.map((label) => label.trim()).filter((label) => label !== '');
  const types = typeValues(repo.triage);
  const type = normalized.find((label) =>
    types.some((candidate) => candidate.toLowerCase() === label.toLowerCase()),
  );
  const result = sanitize(normalized, type, repo.triage);
  const kept = [...result.kept];
  if (
    result.issueType !== UNKNOWN_TYPE &&
    !kept.some((label) => label.toLowerCase() === result.issueType.toLowerCase())
  ) {
    kept.push(result.issueType);
  }
  return kept;
}
