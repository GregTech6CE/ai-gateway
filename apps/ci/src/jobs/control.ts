/**
 * control：A 侧控制面（`start` / `finish` / `cleanup`）。
 *
 * A 只做三件事：预检、占位评论、dispatch B；`finish` 负责轮询运行并取回 artifact。
 * 它不渲染、不写最终结论——写回始终发生在 B 的 `finalize` job。
 *
 * artifact 下载单独实现：GitHub 会 302 到对象存储，跟随重定向时必须**剥离**
 * `Authorization`，否则 token 会随请求发往第三方域名。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { extractZip } from '@gt6ce/agent';
import { formatPendingTag } from '@gt6ce/github';
import { loadBudgetsConfig, loadReposConfig, resolveRepoConfig } from '@gt6ce/shared';

import {
  errorMessage,
  isJobEntry,
  logStageDirs,
  optionalEnv,
  readJsonFile,
  requireEnv,
  resolveDirs,
  writeGithubOutput,
  writeJsonFile,
  writeTextFile,
  type StageDirs,
} from '../common.ts';

export interface ControlEnv {
  readonly REPO: string;
  readonly ISSUE: string;
  readonly EVENT: string;
  readonly COMMENT_ID: string;
  readonly REQUEST_ID: string;
  readonly RUN_URL: string;
  readonly BOT_NAME: string;
  readonly B_REPO: string;
  readonly GH_RW_TOKEN: string;
  readonly B_PAT: string;
  readonly DRY_RUN: string;
  readonly GITHUB_EVENT_NAME: string;
  readonly DEBOUNCE_SECONDS: string;
  readonly DEBOUNCE_MAX_SECONDS: string;
  readonly RUN_ID: string;
  readonly OUT_DIR: string;
  readonly TIMEOUT_MINUTES: string;
}

export function readControlEnv(source: NodeJS.ProcessEnv = process.env): ControlEnv {
  return {
    REPO: requireEnv(source, 'REPO'),
    ISSUE: requireEnv(source, 'ISSUE'),
    EVENT: optionalEnv(source, 'EVENT') || 'issues',
    COMMENT_ID: optionalEnv(source, 'COMMENT_ID'),
    REQUEST_ID: optionalEnv(source, 'REQUEST_ID'),
    RUN_URL: optionalEnv(source, 'RUN_URL'),
    BOT_NAME: optionalEnv(source, 'BOT_NAME') || 'gt6ce-bot',
    B_REPO: optionalEnv(source, 'B_REPO') || 'GregTech6CE/ai-gateway',
    GH_RW_TOKEN: requireEnv(source, 'GH_RW_TOKEN'),
    B_PAT: optionalEnv(source, 'B_PAT'),
    DRY_RUN: optionalEnv(source, 'DRY_RUN') || 'false',
    GITHUB_EVENT_NAME: optionalEnv(source, 'GITHUB_EVENT_NAME'),
    DEBOUNCE_SECONDS: optionalEnv(source, 'DEBOUNCE_SECONDS') || '60',
    DEBOUNCE_MAX_SECONDS: optionalEnv(source, 'DEBOUNCE_MAX_SECONDS') || '300',
    RUN_ID: optionalEnv(source, 'RUN_ID'),
    OUT_DIR: optionalEnv(source, 'OUT_DIR') || '.',
    TIMEOUT_MINUTES: optionalEnv(source, 'TIMEOUT_MINUTES') || '90',
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface IssueShape {
  readonly title?: string;
  readonly body?: string;
  readonly state?: string;
  readonly labels?: ReadonlyArray<{ readonly name?: string }>;
  readonly pull_request?: unknown;
  readonly updated_at?: string;
  readonly comments?: number;
}

interface CommentShape {
  readonly id?: number;
  readonly body?: string;
}

interface RunShape {
  readonly status?: string;
  readonly conclusion?: string | null;
}

interface ArtifactShape {
  readonly id: number;
  readonly name?: string;
}

export interface ControlDeps {
  readonly dirs: StageDirs;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxPollAttempts?: number;
}

const API = 'https://api.github.com';

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
};

async function api<T>(
  fetchImpl: FetchLike,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gt6ce-ai-gateway-control',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
  }
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

export function placeholderBody(env: ControlEnv, runUrl: string): string {
  const link = runUrl ? `[GitHub Action 运行记录](${runUrl})\n\n` : '';
  return (
    `**${env.BOT_NAME} 正在分析该 Issue...**\n\n` +
    '感谢您的反馈！AI 正在自动分析该问题，预计耗时约 10 分钟。\n\n' +
    '---\n\n' +
    link +
    formatPendingTag(env.REQUEST_ID || '0') +
    '\n'
  );
}

async function postPlaceholder(env: ControlEnv, deps: ControlDeps): Promise<CommentShape> {
  return await api<CommentShape>(
    deps.fetchImpl ?? fetch,
    'POST',
    `/repos/${env.REPO}/issues/${env.ISSUE}/comments`,
    env.GH_RW_TOKEN,
    { body: placeholderBody(env, env.RUN_URL) },
  );
}

/** 只更新自己写的占位评论：标记里的 request 必须与本次一致。 */
async function updatePlaceholder(
  env: ControlEnv,
  deps: ControlDeps,
  commentId: string,
  runUrl: string,
): Promise<void> {
  if (!commentId) {
    return;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const current = await api<CommentShape>(
      fetchImpl,
      'GET',
      `/repos/${env.REPO}/issues/comments/${commentId}`,
      env.GH_RW_TOKEN,
    );
    if (!(current.body ?? '').includes(formatPendingTag(env.REQUEST_ID || '0'))) {
      return;
    }
    await api(fetchImpl, 'PATCH', `/repos/${env.REPO}/issues/comments/${commentId}`, env.GH_RW_TOKEN, {
      body: placeholderBody(env, runUrl),
    });
  } catch (error) {
    process.stderr.write(`placeholder update failed: ${errorMessage(error)}\n`);
  }
}

interface PrecheckResult {
  readonly skip?: string;
  readonly title: string;
}

async function precheck(env: ControlEnv, deps: ControlDeps): Promise<PrecheckResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const dirs = deps.dirs;
  let repoEnabled = true;
  let processOnly: readonly (readonly string[])[] = [];
  try {
    const repoCfg = resolveRepoConfig(loadReposConfig(dirs.config), env.REPO);
    repoEnabled = repoCfg.enabled;
    processOnly = repoCfg.triage.process_only;
  } catch {
    // 配置不可读时按未启用处理，避免在未知仓库上创建占位评论。
    repoEnabled = false;
  }
  if (!repoEnabled) {
    return { skip: 'repo disabled', title: '' };
  }

  const issue = await api<IssueShape>(
    fetchImpl,
    'GET',
    `/repos/${env.REPO}/issues/${env.ISSUE}`,
    env.GH_RW_TOKEN,
  );
  let title = '';
  try {
    const repo = await api<{ private?: boolean }>(
      fetchImpl,
      'GET',
      `/repos/${env.REPO}`,
      env.GH_RW_TOKEN,
    );
    if (!repo.private) {
      title = (issue.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  } catch {
    title = '';
  }
  if (issue.pull_request) {
    return { skip: 'pull request, not an issue', title };
  }
  if (issue.state !== 'open') {
    return { skip: 'issue is not open', title };
  }
  if (processOnly.length > 0) {
    const labels = new Set(
      (issue.labels ?? []).map((label) => (label.name ?? '').toLowerCase()),
    );
    const matched = processOnly.some((group) =>
      group.every((label) => labels.has(label.toLowerCase())),
    );
    if (!matched) {
      return { skip: 'process_only not matched', title };
    }
  }
  return { title };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function issueFingerprint(
  env: ControlEnv,
  deps: ControlDeps,
): Promise<[string, number, string]> {
  const issue = await api<IssueShape>(
    deps.fetchImpl ?? fetch,
    'GET',
    `/repos/${env.REPO}/issues/${env.ISSUE}`,
    env.GH_RW_TOKEN,
  );
  return [
    issue.updated_at ?? '',
    issue.comments ?? 0,
    sha256(`${issue.title ?? ''}\n${issue.body ?? ''}`),
  ];
}

/** 新建或编辑中的 issue 先等一个稳定窗口；手动触发不等。 */
async function waitForStable(env: ControlEnv, deps: ControlDeps): Promise<void> {
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    return;
  }
  const interval = Number.parseInt(env.DEBOUNCE_SECONDS, 10);
  const maxWait = Number.parseInt(env.DEBOUNCE_MAX_SECONDS, 10);
  if (!Number.isFinite(interval) || !Number.isFinite(maxWait) || interval <= 0 || maxWait <= 0) {
    return;
  }
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + maxWait * 1000;
  let fingerprint = await issueFingerprint(env, deps);
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      process.stderr.write('debounce cap reached; dispatching anyway\n');
      return;
    }
    await sleep(Math.min(interval * 1000, remaining));
    const current = await issueFingerprint(env, deps);
    if (current.join('|') === fingerprint.join('|')) {
      return;
    }
    process.stderr.write('issue changed; restarting debounce window\n');
    fingerprint = current;
  }
}

export interface StartOutcome {
  readonly skipped?: string;
  readonly commentId?: number;
  readonly runId?: number;
  readonly runUrl?: string;
}

export async function start(env: ControlEnv, deps: ControlDeps): Promise<StartOutcome> {
  if (!env.B_PAT) {
    throw new Error('B_PAT 缺失，无法 dispatch');
  }
  const dryRun = env.DRY_RUN === 'true';
  const first = await precheck(env, deps);
  if (first.skip) {
    return { skipped: first.skip };
  }
  await waitForStable(env, deps);
  const second = await precheck(env, deps);
  if (second.skip) {
    return { skipped: second.skip };
  }

  const comment = dryRun ? {} : await postPlaceholder(env, deps);
  const payload = {
    ref: 'master',
    return_run_details: true,
    inputs: {
      repo: env.REPO,
      issue: env.ISSUE,
      issue_title: second.title,
      event: env.EVENT,
      comment_id: env.COMMENT_ID,
      placeholder_comment_id: String(comment.id ?? ''),
      dry_run: dryRun ? 'true' : 'false',
      request_id: env.REQUEST_ID,
      force: 'true',
    },
  };

  let dispatched: { workflow_run_id?: number; run_id?: number };
  try {
    dispatched = await api<{ workflow_run_id?: number; run_id?: number }>(
      deps.fetchImpl ?? fetch,
      'POST',
      `/repos/${env.B_REPO}/actions/workflows/orchestrator.yml/dispatches`,
      env.B_PAT,
      payload,
    );
  } catch (error) {
    if (comment.id) {
      await api(
        deps.fetchImpl ?? fetch,
        'DELETE',
        `/repos/${env.REPO}/issues/comments/${comment.id}`,
        env.GH_RW_TOKEN,
      ).catch(() => undefined);
    }
    throw error;
  }

  const runId = dispatched.workflow_run_id ?? dispatched.run_id;
  if (runId === undefined) {
    if (comment.id) {
      await api(
        deps.fetchImpl ?? fetch,
        'DELETE',
        `/repos/${env.REPO}/issues/comments/${comment.id}`,
        env.GH_RW_TOKEN,
      ).catch(() => undefined);
    }
    throw new Error(`dispatch did not return workflow_run_id: ${JSON.stringify(dispatched)}`);
  }
  const runUrl = `https://github.com/${env.B_REPO}/actions/runs/${runId}`;
  await updatePlaceholder(env, deps, String(comment.id ?? ''), runUrl);
  writeGithubOutput({
    comment_id: String(comment.id ?? ''),
    run_id: String(runId),
    run_url: runUrl,
  });
  return { commentId: comment.id, runId, runUrl };
}

/** 轮询 B 的运行状态；鉴权类错误直接抛出，其余继续等到超时。 */
export async function waitRun(
  env: ControlEnv,
  deps: ControlDeps,
  runId: string,
): Promise<RunShape> {
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = Number.parseInt(env.TIMEOUT_MINUTES, 10) * 60_000;
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 90 * 60_000);
  const maxAttempts = deps.maxPollAttempts ?? Number.POSITIVE_INFINITY;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const run = await api<RunShape>(
        deps.fetchImpl ?? fetch,
        'GET',
        `/repos/${env.B_REPO}/actions/runs/${runId}`,
        env.B_PAT,
      );
      if (run.status === 'completed' || attempts >= maxAttempts) {
        return run;
      }
    } catch (error) {
      if (attempts >= maxAttempts) {
        throw error;
      }
      process.stderr.write(`poll failed: ${errorMessage(error)}\n`);
    }
    if (Date.now() > deadline) {
      return { status: 'timeout', conclusion: 'timed_out' };
    }
    await sleep(20_000);
  }
}

/**
 * 带 token 下载 artifact。
 *
 * 手动跟随重定向：只要目标 origin 与当前不同就剥离 `Authorization`，
 * 避免 App token 被发往对象存储或任何第三方域名。
 */
export async function downloadArtifactZip(
  url: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  let current = url;
  let withAuth = true;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(current, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gt6ce-ai-gateway-control',
        ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`重定向缺少 Location: ${response.status}`);
      }
      const next = new URL(location, current);
      if (next.origin !== new URL(current).origin) {
        withAuth = false;
      }
      current = next.toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`下载 artifact 失败: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('重定向次数过多');
}

function fallbackResult(runId: string, run: RunShape): Record<string, unknown> {
  const outcome = run.conclusion ?? run.status ?? 'unknown';
  return {
    status: 'failed',
    reason: `B run ${runId} ${outcome}`,
    steps: 0,
    tokens: 0,
    elapsed_sec: 0,
    attempts: 0,
    entry_id: '',
    confidence: '',
    run_conclusion: outcome,
  };
}

export interface FinishOutcome {
  readonly runId: string;
  readonly conclusion: string;
  readonly artifacts: string[];
}

export async function finish(env: ControlEnv, deps: ControlDeps): Promise<FinishOutcome> {
  if (!env.RUN_ID) {
    throw new Error('RUN_ID 缺失');
  }
  if (!env.B_PAT) {
    throw new Error('B_PAT 缺失，无法读取运行状态');
  }
  const run = await waitRun(env, deps, env.RUN_ID);
  const out = resolve(env.OUT_DIR);

  let artifacts: ArtifactShape[] = [];
  try {
    const listing = await api<{ artifacts?: ArtifactShape[] }>(
      deps.fetchImpl ?? fetch,
      'GET',
      `/repos/${env.B_REPO}/actions/runs/${env.RUN_ID}/artifacts?per_page=100`,
      env.B_PAT,
    );
    artifacts = listing.artifacts ?? [];
  } catch (error) {
    process.stderr.write(`list artifacts failed: ${errorMessage(error)}\n`);
  }

  const budgets = loadBudgetsConfig(deps.dirs.config).defaults;
  const limits = {
    maxAttachmentBytes: budgets.artifacts.max_attachment_bytes,
    maxTotalAttachmentBytes: budgets.artifacts.max_total_attachment_bytes,
  };

  const found: string[] = [];
  for (const artifact of artifacts) {
    const name = artifact.name ?? '';
    if (name !== `gate-${env.RUN_ID}` && name !== `analysis-${env.RUN_ID}`) {
      continue;
    }
    try {
      const zip = await downloadArtifactZip(
        `${API}/repos/${env.B_REPO}/actions/artifacts/${artifact.id}/zip`,
        env.B_PAT,
        deps.fetchImpl ?? fetch,
      );
      mkdirSync(out, { recursive: true });
      extractZip(zip, out, limits);
      found.push(name);
    } catch (error) {
      process.stderr.write(`download ${name} failed: ${errorMessage(error)}\n`);
    }
  }

  const verdict = readJsonFile<{ decision?: string }>(join(out, 'inputs', 'verdict.json'));
  if (verdict) {
    process.stdout.write(`${JSON.stringify({ verdict })}\n`);
  }
  const resultPath = join(out, 'outputs', 'result.json');
  if (!readJsonFile(resultPath)) {
    const decision = verdict?.decision;
    if (decision === 'proceed' || (!verdict && run.conclusion !== 'success')) {
      writeJsonFile(resultPath, fallbackResult(env.RUN_ID, run));
      process.stdout.write(
        `${JSON.stringify({ result_fallback: fallbackResult(env.RUN_ID, run) })}\n`,
      );
    }
  }

  return {
    runId: env.RUN_ID,
    conclusion: run.conclusion ?? run.status ?? 'unknown',
    artifacts: found,
  };
}

export async function cleanup(env: ControlEnv, deps: ControlDeps): Promise<void> {
  if (!env.COMMENT_ID) {
    return;
  }
  try {
    await api(
      deps.fetchImpl ?? fetch,
      'DELETE',
      `/repos/${env.REPO}/issues/comments/${env.COMMENT_ID}`,
      env.GH_RW_TOKEN,
    );
    process.stdout.write(`deleted placeholder ${env.COMMENT_ID}\n`);
  } catch (error) {
    process.stderr.write(`delete placeholder failed: ${errorMessage(error)}\n`);
  }
}

export async function main(command: string | undefined): Promise<void> {
  const env = readControlEnv();
  const deps: ControlDeps = { dirs: resolveDirs() };
  logStageDirs(`control:${command ?? 'none'}`, deps.dirs);
  switch (command) {
    case 'start': {
      const outcome = await start(env, deps);
      writeTextFile(
        join(deps.dirs.outputs, 'control.json'),
        `${JSON.stringify(outcome, null, 2)}\n`,
      );
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      return;
    }
    case 'finish': {
      const outcome = await finish(env, deps);
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      return;
    }
    case 'cleanup':
      await cleanup(env, deps);
      return;
    default:
      throw new Error(`未知命令: ${command ?? '(空)'}`);
  }
}

if (isJobEntry('control')) {
  await main(process.argv[2]);
}
