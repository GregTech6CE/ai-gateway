/**
 * write-back：发布评论与标签。
 *
 * 这一阶段在 `finalize` job 内运行，只持有 `issues: write` 的 App token，不运行 agent。
 * 三条硬约束：
 * 1. `DRY_RUN` 只渲染不发布；
 * 2. `bot:stop` 与已关闭 issue 会被就地拦下，只回一条停止说明；
 * 3. 发布前 `scanText` 强制扫描，命中即阻断——分析阶段的 `secret_scan` 结论同样会阻断。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GitHubClient,
  SecretScanBlockedError,
  applyTriage,
  formatFailedTag,
  getIssue,
  isBotStopLabeled,
  publishComment,
  type FetchLike,
  type GitHubApi,
} from '@gt6ce/github';
import { loadReposConfig, resolveRepoConfig, safeParseAnswer } from '@gt6ce/shared';

import {
  errorMessage,
  isJobEntry,
  optionalEnv,
  readJsonFile,
  requireEnv,
  resolveDirs,
  writeJsonFile,
  type StageDirs,
} from '../common.ts';

export interface WriteBackEnv {
  readonly REPO: string;
  readonly ISSUE: string;
  readonly COMMENT_ID: string;
  readonly GH_RW_TOKEN: string;
  readonly GH_RO_TOKEN: string;
  readonly BOT_ENABLED: string;
  readonly DRY_RUN: string;
  readonly RUN_URL: string;
  readonly RUN_ID: string;
}

export function readWriteBackEnv(source: NodeJS.ProcessEnv = process.env): WriteBackEnv {
  const rw = optionalEnv(source, 'GH_RW_TOKEN');
  return {
    REPO: requireEnv(source, 'REPO'),
    ISSUE: requireEnv(source, 'ISSUE'),
    COMMENT_ID: optionalEnv(source, 'COMMENT_ID'),
    GH_RW_TOKEN: rw,
    GH_RO_TOKEN: optionalEnv(source, 'GH_RO_TOKEN') || rw,
    BOT_ENABLED: optionalEnv(source, 'BOT_ENABLED') || 'true',
    DRY_RUN: optionalEnv(source, 'DRY_RUN') || 'false',
    RUN_URL: optionalEnv(source, 'RUN_URL'),
    RUN_ID: optionalEnv(source, 'GITHUB_RUN_ID') || '0',
  };
}

export type WriteBackAction = 'dry-run' | 'skipped' | 'published' | 'stopped' | 'blocked';

export interface WriteBackOutcome {
  readonly action: WriteBackAction;
  readonly reason?: string;
  readonly commentId?: string;
}

interface ScanReport {
  readonly ok?: boolean;
  readonly hits?: readonly string[];
}

interface ResultShape {
  readonly secret_scan?: ScanReport;
}

export interface WriteBackOptions {
  readonly env: WriteBackEnv;
  readonly dirs: StageDirs;
  readonly fetchImpl?: FetchLike;
}

function notice(runUrl: string, runId: string, text: string): string {
  const link = runUrl ? `[运行记录](${runUrl})\n\n` : '';
  return `${text}\n\n${link}${formatFailedTag(runId)}\n`;
}

/** 主流程；返回动作而不是直接退出，便于测试与工作流分支。 */
export async function runWriteBack(options: WriteBackOptions): Promise<WriteBackOutcome> {
  const { env, dirs } = options;
  if (env.DRY_RUN === 'true') {
    return { action: 'dry-run' };
  }

  const commentPath = join(dirs.outputs, 'comment.md');
  if (!existsSync(commentPath)) {
    return { action: 'skipped', reason: 'comment.md 缺失' };
  }
  const body = readFileSync(commentPath, 'utf8');
  const result = readJsonFile<ResultShape>(join(dirs.outputs, 'result.json')) ?? {};
  const issue = await getIssue(
    new GitHubClient({ token: env.GH_RO_TOKEN, fetchImpl: options.fetchImpl }),
    env.REPO,
    env.ISSUE,
  );
  const rw: GitHubApi = new GitHubClient({ token: env.GH_RW_TOKEN, fetchImpl: options.fetchImpl });
  const parsedNumber = Number.parseInt(env.ISSUE, 10);
  const issueNumber: number | string = Number.isFinite(parsedNumber) ? parsedNumber : env.ISSUE;

  if (env.BOT_ENABLED === 'false') {
    await publishComment({
      api: rw,
      repo: env.REPO,
      issueNumber,
      body: notice(env.RUN_URL, env.RUN_ID, '分析已停止（功能已被禁用）。'),
      commentId: env.COMMENT_ID,
    });
    return { action: 'stopped', reason: 'bot disabled' };
  }
  if (isBotStopLabeled(issue)) {
    await publishComment({
      api: rw,
      repo: env.REPO,
      issueNumber,
      body: notice(env.RUN_URL, env.RUN_ID, '分析已停止（bot:stop）。'),
      commentId: env.COMMENT_ID,
    });
    return { action: 'stopped', reason: 'bot:stop' };
  }
  if (issue.state !== 'open') {
    await publishComment({
      api: rw,
      repo: env.REPO,
      issueNumber,
      body: notice(env.RUN_URL, env.RUN_ID, '分析已停止（issue 已关闭）。'),
      commentId: env.COMMENT_ID,
    });
    return { action: 'stopped', reason: 'issue closed' };
  }

  if (result.secret_scan?.ok === false) {
    await publishComment({
      api: rw,
      repo: env.REPO,
      issueNumber,
      body: notice(
        env.RUN_URL,
        env.RUN_ID,
        '分析结果包含疑似敏感信息，已被拦截，未公开。维护者可在运行 artifact 中查看。',
      ),
      commentId: env.COMMENT_ID,
    });
    return { action: 'blocked', reason: 'secret_scan' };
  }

  let commentId: string | undefined;
  try {
    const published = await publishComment({
      api: rw,
      repo: env.REPO,
      issueNumber,
      body,
      commentId: env.COMMENT_ID,
      extraSecrets: [],
    });
    commentId = published.commentId;
  } catch (error) {
    if (error instanceof SecretScanBlockedError) {
      await publishComment({
        api: rw,
        repo: env.REPO,
        issueNumber,
        body: notice(
          env.RUN_URL,
          env.RUN_ID,
          '分析结果包含疑似敏感信息，已被拦截，未公开。维护者可在运行 artifact 中查看。',
        ),
      });
      return { action: 'blocked', reason: error.hits.join(', ') };
    }
    throw error;
  }

  const answerRaw = readJsonFile<unknown>(join(dirs.outputs, 'answer.json'));
  const parsed = answerRaw === undefined ? undefined : safeParseAnswer(answerRaw);
  try {
    const repoCfg = resolveRepoConfig(loadReposConfig(dirs.config), env.REPO);
    const triage = await applyTriage({
      api: rw,
      repo: env.REPO,
      issueNumber,
      issue: { labels: issue.labels ?? [] },
      labels: parsed?.ok ? parsed.answer.labels : [],
      issueType: parsed?.ok ? parsed.answer.issue_type : '',
      triage: repoCfg.triage,
    });
    writeJsonFile(join(dirs.outputs, 'triage.json'), triage);
  } catch (error) {
    // 标签失败不影响评论已发布的事实，也不应让整个 run 失败。
    process.stderr.write(`triage apply failed: ${errorMessage(error)}\n`);
  }

  return { action: 'published', commentId };
}

export async function main(): Promise<void> {
  const outcome = await runWriteBack({ env: readWriteBackEnv(), dirs: resolveDirs() });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (outcome.action === 'blocked') {
    process.exitCode = 1;
  }
}

if (isJobEntry('write-back')) {
  await main();
}
