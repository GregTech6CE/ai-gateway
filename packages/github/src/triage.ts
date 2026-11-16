/**
 * 写回：评论发布、`bot:stop` 开关与标签增删。
 *
 * 三条约束来自公开面边界：
 *
 * 1. **发布前强制扫描**：正文必须过 `scanText`，命中即抛 `SecretScanBlockedError`，
 *    调用方只能改发一条拦截说明。扫描发生在这里而不是调用方，避免某条路径漏传。
 * 2. **PATCH 优先**：占位评论还在就原地更新；404/410 说明占位被删，回退新建。
 * 3. **只增已存在的标签**：仓库里没有的标签不新建，避免 422 与制造标签垃圾。
 */
import { GitHubApiError, scanText, type TriageConfig } from '@gt6ce/shared';

import type { GitHubApi } from './client.ts';
import { sanitize, type DroppedLabel } from './labels.ts';

export const STOP_LABEL = 'bot:stop';

export interface LabelRef {
  readonly name?: string;
}

export type IssueLabel = string | LabelRef;

export interface GitHubIssue {
  readonly number: number;
  readonly state?: string;
  readonly title?: string;
  readonly labels?: readonly IssueLabel[];
}

function labelName(ref: IssueLabel): string {
  return typeof ref === 'string' ? ref.trim() : (ref.name ?? '').trim();
}

/** 发布前扫描命中敏感信息的阻断错误。 */
export class SecretScanBlockedError extends Error {
  readonly hits: readonly string[];

  constructor(hits: readonly string[]) {
    super(`发布前扫描命中敏感信息: ${hits.join(', ')}`);
    this.name = 'SecretScanBlockedError';
    this.hits = [...hits];
  }
}

/** `bot:stop` 是人工开关：任何写回前都要先看它。 */
export function isBotStopLabeled(issue: { readonly labels?: readonly IssueLabel[] }): boolean {
  return (issue.labels ?? []).some((ref) => labelName(ref).toLowerCase() === STOP_LABEL);
}

export async function getIssue(
  api: GitHubApi,
  repo: string,
  issueNumber: number | string,
): Promise<GitHubIssue> {
  return api.request<GitHubIssue>('GET', `/repos/${repo}/issues/${issueNumber}`);
}

export interface PublishCommentInput {
  readonly api: GitHubApi;
  readonly repo: string;
  readonly issueNumber: number | string;
  readonly body: string;
  /** 占位评论 id；给了就 PATCH，缺失或已删除才新建。 */
  readonly commentId?: string;
  /** 已知凭据值，参与精确匹配扫描。 */
  readonly extraSecrets?: readonly string[];
}

export interface PublishCommentResult {
  readonly action: 'patched' | 'created';
  readonly commentId?: string;
}

/**
 * 发布评论。
 *
 * 404/410 之外的非 2xx 直接抛出：那说明是凭据、权限或限流问题，
 * 静默新建只会在 issue 里堆重复评论。
 */
export async function publishComment(input: PublishCommentInput): Promise<PublishCommentResult> {
  const hits = scanText(input.body, input.extraSecrets ?? []);
  if (hits.length > 0) {
    throw new SecretScanBlockedError(hits);
  }

  if (input.commentId) {
    try {
      await input.api.request<unknown>(
        'PATCH',
        `/repos/${input.repo}/issues/comments/${input.commentId}`,
        { body: input.body },
      );
      return { action: 'patched', commentId: input.commentId };
    } catch (error) {
      const missing =
        error instanceof GitHubApiError && (error.status === 404 || error.status === 410);
      if (!missing) {
        throw error;
      }
    }
  }

  const created = await input.api.request<{ readonly id?: number } | undefined>(
    'POST',
    `/repos/${input.repo}/issues/${input.issueNumber}/comments`,
    { body: input.body },
  );
  return {
    action: 'created',
    commentId: created?.id !== undefined ? String(created.id) : undefined,
  };
}

export interface TriageInput {
  readonly api: GitHubApi;
  readonly repo: string;
  readonly issueNumber: number | string;
  readonly issue: { readonly labels?: readonly IssueLabel[] };
  /** 模型给出的原始标签，未归一化。 */
  readonly labels: readonly string[];
  readonly issueType: unknown;
  readonly triage: TriageConfig;
}

export interface TriageResult {
  readonly kept: readonly string[];
  readonly dropped: readonly DroppedLabel[];
  readonly issueType: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * 应用标签：先过六轴门禁，再只补仓库里已存在的标签。
 *
 * `resolved` 表示「模型给的标签至少有一个在 issue 或仓库里成立」；只有成立时
 * 才摘掉 `needs triage` 这类触发标签，避免一次无效分类把待办标记吞掉。
 */
export async function applyTriage(input: TriageInput): Promise<TriageResult> {
  const { api, repo, issueNumber, triage } = input;
  const result = sanitize(input.labels, input.issueType, triage);
  const outcome: TriageResult = {
    kept: result.kept,
    dropped: result.dropped,
    issueType: result.issueType,
    added: [],
    removed: [],
  };
  if (result.kept.length === 0) {
    return outcome;
  }

  const current = new Map<string, string>();
  for (const ref of input.issue.labels ?? []) {
    const name = labelName(ref);
    if (name) {
      current.set(name.toLowerCase(), name);
    }
  }

  let repoLabels: readonly LabelRef[] = [];
  try {
    repoLabels = await api.paginate<LabelRef>(`/repos/${repo}/labels`, { maxPages: 2 });
  } catch {
    // 读不到仓库标签时只保留 issue 上已有的，不猜新标签。
    repoLabels = [];
  }
  const existing = new Map<string, string>();
  for (const label of repoLabels) {
    const name = (label.name ?? '').trim();
    if (name) {
      existing.set(name.toLowerCase(), name);
    }
  }

  const toAdd: string[] = [];
  let resolved = false;
  for (const label of result.kept) {
    const key = label.toLowerCase();
    if (current.has(key) || existing.has(key)) {
      resolved = true;
    }
    const canonical = existing.get(key);
    if (canonical !== undefined && !current.has(key)) {
      toAdd.push(canonical);
    }
  }
  if (toAdd.length > 0) {
    await api.request('POST', `/repos/${repo}/issues/${issueNumber}/labels`, { labels: toAdd });
  }

  const removed: string[] = [];
  if (triage.remove_after_triage && resolved) {
    const triggers = new Set(triage.triage_labels.map((item) => item.toLowerCase()));
    for (const trigger of triggers) {
      const name = current.get(trigger);
      if (name === undefined) {
        continue;
      }
      await api.request(
        'DELETE',
        `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`,
      );
      removed.push(name);
    }
  }

  return { ...outcome, added: toAdd, removed };
}
