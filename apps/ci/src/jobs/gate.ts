/**
 * gate：只读校验与快照。
 *
 * 这一阶段不写 issue、不发评论、不持有 App 私钥、不调用模型；它只决定「这次请求是否
 * 值得进入分析」，并把后续阶段需要的事实固化成 `inputs/`。
 *
 * 判定顺序即优先级：
 * 1. 配置与开关（仓库白名单、`BOT_ENABLED`）；
 * 2. 可见性与 issue 形态（PR、已关闭、`process_only` 标签）；
 * 3. 触发者授权（issue_comment 只接受维护者的 @bot）；
 * 4. 被动触发的兜底：`bot:stop` 标签、`bot:v1:` 标记、7 天超期；
 * 5. 版本 ref 解析与快照。
 *
 * `force`（手动触发或维护者显式 @bot）无视第 4 步的一切标记与时间窗口——这是
 * 「主动强制」相对「被动触发」的唯一区别。
 */
import { join } from 'node:path';

import {
  candidates,
  listRemoteTags,
  loadPool,
  parseHealth,
  resolveVersionTag,
  versionBase,
  type ModelEntry,
} from '@gt6ce/agent';
import {
  ConfigError,
  loadBudgetsConfig,
  loadModelsConfig,
  loadReposConfig,
  resolveRepoConfig,
  type BudgetDefaults,
  type ResolvedRepoConfig,
} from '@gt6ce/shared';
import {
  GitHubClient,
  botLoginMatches,
  extractAttachmentUrls,
  isBotStopLabeled,
  shouldSkipPassiveTrigger,
  type FetchLike,
} from '@gt6ce/github';

import {
  errorMessage,
  isJobEntry,
  optionalEnv,
  requireEnv,
  resolveDirs,
  stageLogger,
  writeGithubOutput,
  writeJsonFile,
  writeTextFile,
  type StageDirs,
} from '../common.ts';

const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ALLOWED_EVENTS = new Set(['issues', 'issue_comment']);
const COMMENT_PAGE_LIMIT = 5;

interface IssueLabel {
  readonly name?: string;
}

interface GateIssue {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly IssueLabel[];
  readonly state?: string;
  readonly pull_request?: unknown;
  readonly author_association?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly user?: { readonly login?: string; readonly type?: string };
}

interface GateComment {
  readonly id?: number;
  readonly body?: string;
  readonly created_at?: string;
  readonly issue_url?: string;
  readonly author_association?: string;
  readonly user?: { readonly login?: string; readonly type?: string };
}

/** gate 只读取这些变量：没有 `MODEL_KEY_*`，也没有写权限 token。 */
export interface GateEnv {
  readonly REPO: string;
  readonly ISSUE: string;
  readonly EVENT: string;
  readonly COMMENT_ID: string;
  readonly REQUEST_ID: string;
  readonly FORCE: string;
  readonly BOT_ENABLED: string;
  readonly MODEL_HEALTH: string;
  readonly SELF_TOKEN: string;
  readonly GH_RO_TOKEN: string;
  readonly B_REPO: string;
}

export function readGateEnv(source: NodeJS.ProcessEnv = process.env): GateEnv {
  return {
    REPO: requireEnv(source, 'REPO'),
    ISSUE: requireEnv(source, 'ISSUE'),
    EVENT: optionalEnv(source, 'EVENT') || 'issues',
    COMMENT_ID: optionalEnv(source, 'COMMENT_ID'),
    REQUEST_ID: optionalEnv(source, 'REQUEST_ID'),
    FORCE: optionalEnv(source, 'FORCE'),
    BOT_ENABLED: optionalEnv(source, 'BOT_ENABLED') || 'true',
    MODEL_HEALTH: optionalEnv(source, 'MODEL_HEALTH'),
    SELF_TOKEN: optionalEnv(source, 'SELF_TOKEN'),
    GH_RO_TOKEN: optionalEnv(source, 'GH_RO_TOKEN'),
    B_REPO: optionalEnv(source, 'B_REPO'),
  };
}

export interface GateOutcome {
  readonly decision: 'proceed' | 'skip';
  readonly reason: string;
  readonly verdict: Record<string, unknown>;
  readonly outputs: Record<string, string>;
}

export interface GateOptions {
  readonly env: GateEnv;
  readonly dirs: StageDirs;
  readonly fetchImpl?: FetchLike;
  readonly now?: Date;
  /** 测试注入；生产走 `git ls-remote`。 */
  readonly remoteTags?: ReadonlySet<string>;
}

function labelNames(issue: { readonly labels?: readonly IssueLabel[] }): string[] {
  return (issue.labels ?? []).map((label) => label.name ?? '').filter(Boolean);
}

function cachePrefix(codeRepo: string): string {
  return `gt6-mirror-${codeRepo.toLowerCase().replaceAll('/', '-')}`;
}

async function loadConfigs(dirs: StageDirs): Promise<{
  repos: ReturnType<typeof loadReposConfig>;
  models: ReturnType<typeof loadModelsConfig>;
  budgets: BudgetDefaults;
}> {
  return {
    repos: loadReposConfig(dirs.config),
    models: loadModelsConfig(dirs.config),
    budgets: loadBudgetsConfig(dirs.config).defaults,
  };
}

/** 主流程；所有分支都通过 `finish` 收口，保证 `verdict.json` 一定被写出。 */
export async function runGate(options: GateOptions): Promise<GateOutcome> {
  const { env, dirs } = options;
  const now = options.now ?? new Date();
  const log = stageLogger('gate', []);
  const issueNumber = Number.parseInt(env.ISSUE, 10);
  const issueRef: number | string = Number.isFinite(issueNumber) ? issueNumber : env.ISSUE;

  const finish = (
    decision: 'proceed' | 'skip',
    reason: string,
    extra: Record<string, string> = {},
  ): GateOutcome => {
    const verdict: Record<string, unknown> = {
      decision,
      reason,
      repo: env.REPO,
      issue: issueRef,
      captured_at: now.toISOString(),
      ...extra,
    };
    writeJsonFile(join(dirs.inputs, 'verdict.json'), verdict);
    const level = decision === 'proceed' ? 'info' : 'warn';
    log[level]('gate 决策', { decision, reason, repo: env.REPO, issue: issueRef });
    return {
      decision,
      reason,
      verdict,
      outputs: { decision, reason, ...extra },
    };
  };

  let config;
  try {
    config = await loadConfigs(dirs);
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : errorMessage(error);
    return finish('skip', reason);
  }

  let repoCfg: ResolvedRepoConfig;
  try {
    repoCfg = resolveRepoConfig(config.repos, env.REPO);
  } catch (error) {
    return finish('skip', errorMessage(error));
  }

  if (env.BOT_ENABLED === 'false') {
    return finish('skip', 'BOT_ENABLED=false');
  }
  if (!repoCfg.enabled) {
    return finish('skip', 'repo disabled');
  }
  if (!ALLOWED_EVENTS.has(env.EVENT)) {
    return finish('skip', `unknown event: ${env.EVENT}`);
  }

  let pool;
  try {
    pool = loadPool(config.models, repoCfg.model_pool);
  } catch (error) {
    return finish('skip', errorMessage(error));
  }
  const health = parseHealth(env.MODEL_HEALTH);
  writeJsonFile(join(dirs.inputs, 'model_health.json'), health);

  const gh = new GitHubClient({ token: env.GH_RO_TOKEN, fetchImpl: options.fetchImpl });
  const self = new GitHubClient({ token: env.SELF_TOKEN, fetchImpl: options.fetchImpl });

  if (env.B_REPO) {
    try {
      const botRepo = await self.request<{ private?: boolean }>('GET', `/repos/${env.B_REPO}`);
      if (!botRepo.private) {
        const target = await gh.request<{ private?: boolean }>('GET', `/repos/${env.REPO}`);
        if (target.private) {
          return finish('skip', 'private issue repo with public bot repo');
        }
      }
    } catch (error) {
      return finish('skip', `visibility check failed: ${errorMessage(error)}`);
    }
  }

  const issue = await gh.request<GateIssue>(
    'GET',
    `/repos/${env.REPO}/issues/${issueNumber}`,
  );
  if (issue.pull_request) {
    return finish('skip', 'pull request, not an issue');
  }
  if (issue.state !== 'open') {
    return finish('skip', 'issue is not open');
  }

  const groups = repoCfg.triage.process_only;
  if (groups.length > 0) {
    const present = new Set(labelNames(issue).map((name) => name.toLowerCase()));
    const matched = groups.some((group) =>
      group.every((label) => present.has(label.toLowerCase())),
    );
    if (!matched) {
      return finish('skip', 'process_only not matched');
    }
  }

  let association = issue.author_association ?? '';
  let force = env.FORCE === 'true';

  if (env.EVENT === 'issue_comment') {
    if (!env.COMMENT_ID) {
      return finish('skip', 'comment id missing');
    }
    const comment = await gh.request<GateComment>(
      'GET',
      `/repos/${env.REPO}/issues/comments/${env.COMMENT_ID}`,
    );
    if (!(comment.issue_url ?? '').endsWith(`/issues/${issueNumber}`)) {
      return finish('skip', 'comment does not belong to this issue');
    }
    if (comment.user?.type === 'Bot') {
      return finish('skip', 'bot comment');
    }
    const mention = repoCfg.botMention.toLowerCase();
    if (!mention || !(comment.body ?? '').toLowerCase().includes(mention)) {
      return finish('skip', 'mention missing');
    }
    association = comment.author_association ?? '';
    if (!ALLOWED_ASSOCIATIONS.has(association)) {
      return finish('skip', `comment author is not a maintainer (${association})`);
    }
    // 维护者显式 @bot 视为主动强制执行。
    force = true;
  }

  const comments = await gh.paginate<GateComment>(
    `/repos/${env.REPO}/issues/${issueNumber}/comments`,
    { maxPages: COMMENT_PAGE_LIMIT },
  );
  const botComments = comments.filter((comment) =>
    botLoginMatches(comment.user ?? {}, repoCfg.botLogin),
  );

  if (isBotStopLabeled(issue)) {
    if (!force) {
      return finish('skip', 'bot:stop');
    }
    log.warn('bot:stop 被 force 覆盖', { repo: env.REPO, issue: issueRef });
  }

  const passive = shouldSkipPassiveTrigger({
    force,
    comments: botComments.map((comment) => ({
      body: comment.body ?? '',
      createdAt: comment.created_at,
    })),
    issueCreatedAt: issue.created_at,
    now,
    pendingWindowMinutes: config.budgets.requested_stale_minutes,
    maxIssueAgeDays: config.budgets.max_issue_age_days,
  });
  if (passive.skip) {
    return finish('skip', passive.reason);
  }

  const body = issue.body ?? '';
  const reportedVersion = versionBase(body);
  const tags = options.remoteTags ?? listRemoteTags({ repo: repoCfg.code_repo });
  const versionTag = resolveVersionTag(reportedVersion, tags, repoCfg);

  const refs: string[] = [repoCfg.fallback_ref];
  if (versionTag && !refs.includes(versionTag)) {
    refs.push(versionTag);
  }
  for (const extra of repoCfg.extra_code_refs) {
    if (!refs.includes(extra)) {
      refs.push(extra);
    }
  }

  const title = (issue.title ?? '').trim();
  const attachments = extractAttachmentUrls(
    [body, ...comments.map((comment) => comment.body ?? '')].join('\n'),
  );
  const snapshot = {
    repo: env.REPO,
    issue: {
      number: issue.number,
      title,
      body,
      labels: labelNames(issue),
      author: issue.user?.login ?? '',
      author_association: association,
      created_at: issue.created_at ?? '',
      updated_at: issue.updated_at ?? '',
    },
    comments: comments
      .filter((comment) => !botLoginMatches(comment.user ?? {}, repoCfg.botLogin))
      .map((comment) => ({
        id: comment.id ?? 0,
        author: comment.user?.login ?? '',
        association: comment.author_association ?? '',
        created_at: comment.created_at ?? '',
        body: comment.body ?? '',
      })),
    attachments,
    code_repo: repoCfg.code_repo,
    code_ref: repoCfg.fallback_ref,
    code_refs: refs,
    reported_version: reportedVersion,
    version_tag: versionTag,
    golden: {
      repo: repoCfg.golden?.repo ?? '',
      commit: repoCfg.golden?.commit ?? '',
    },
    captured_at: now.toISOString(),
  };
  writeJsonFile(join(dirs.inputs, 'snapshot.json'), snapshot);
  writeTextFile(join(dirs.inputs, 'issue.md'), `# ${title}\n\n${body}\n`);

  const entries: ModelEntry[] = candidates(pool, 'analysis', health, {
    requireKey: false,
    env: {},
    now,
  });
  writeJsonFile(join(dirs.inputs, 'model.json'), {
    pool: repoCfg.model_pool,
    analysis_entries: entries,
  });

  return finish('proceed', 'accepted', {
    code_repo: snapshot.code_repo,
    code_ref: snapshot.code_ref,
    code_refs: refs.join(' '),
    golden_repo: snapshot.golden.repo,
    golden_commit: snapshot.golden.commit,
    cache_prefix: cachePrefix(repoCfg.code_repo),
    issue_title: title,
  });
}

export async function main(): Promise<void> {
  const env = readGateEnv();
  const dirs = resolveDirs();
  const outcome = await runGate({ env, dirs });
  writeGithubOutput(outcome.outputs);
}

if (isJobEntry('gate')) {
  await main();
}
