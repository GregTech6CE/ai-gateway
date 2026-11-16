/**
 * render：把结构化产物渲染成评论正文。
 *
 * 确定性步骤：不调用模型、不访问网络。gate 跳过时不产出评论；分析失败时输出带
 * `bot:v1:failed` 的失败评论，让后续被动触发仍可重试。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseAnswer,
  renderAnswer,
  renderFailure,
  renderRejection,
  type RenderTemplates,
} from '@gt6ce/github';
import { loadReposConfig, resolveRepoConfig, type Answer } from '@gt6ce/shared';

import {
  errorMessage,
  isJobEntry,
  optionalEnv,
  readJsonFile,
  requireEnv,
  resolveDirs,
  writeTextFile,
  type StageDirs,
} from '../common.ts';

export interface RenderEnv {
  readonly REPO: string;
  readonly ISSUE: string;
  readonly RUN_URL: string;
  readonly RUN_ID: string;
}

export function readRenderEnv(source: NodeJS.ProcessEnv = process.env): RenderEnv {
  return {
    REPO: requireEnv(source, 'REPO'),
    ISSUE: requireEnv(source, 'ISSUE'),
    RUN_URL: optionalEnv(source, 'B_RUN_URL') || optionalEnv(source, 'RUN_URL'),
    RUN_ID:
      optionalEnv(source, 'GITHUB_RUN_ID') ||
      optionalEnv(source, 'REQUEST_ID') ||
      '0',
  };
}

interface VerdictShape {
  readonly decision?: string;
}

interface ResultShape {
  readonly status?: string;
  readonly reason?: string;
}

interface SnapshotShape {
  readonly issue?: {
    readonly title?: string;
    readonly number?: number;
  };
}

interface RelevanceShape {
  readonly relevance?: string;
  readonly reason?: string;
  readonly confidence?: number;
}

export interface RenderOptions {
  readonly env: RenderEnv;
  readonly dirs: StageDirs;
}

export interface RenderOutcome {
  readonly rendered: boolean;
  readonly reason: string;
  readonly path?: string;
}

export function runRender(options: RenderOptions): RenderOutcome {
  const { env, dirs } = options;
  mkdirSync(dirs.outputs, { recursive: true });

  const verdict = readJsonFile<VerdictShape>(join(dirs.inputs, 'verdict.json'));
  if (verdict && verdict.decision !== 'proceed') {
    return { rendered: false, reason: 'gate skipped' };
  }

  const snapshot = readJsonFile<SnapshotShape>(join(dirs.inputs, 'snapshot.json'));
  const result = readJsonFile<ResultShape>(join(dirs.outputs, 'result.json')) ?? {
    status: 'failed',
    reason: 'result missing',
  };
  const answerRaw = readJsonFile<unknown>(join(dirs.outputs, 'answer.json'));
  const relevance = readJsonFile<RelevanceShape>(join(dirs.outputs, 'relevance.json'));

  const repoCfg = resolveRepoConfig(loadReposConfig(dirs.config), env.REPO);
  const templates: RenderTemplates = {
    comment: readFileSync(join(dirs.templates, 'comment.md'), 'utf8'),
    reject: readFileSync(join(dirs.templates, 'reject.md'), 'utf8'),
  };

  const context = {
    repoKey: repoCfg.key,
    runId: env.RUN_ID,
    runUrl: env.RUN_URL,
    issueTitle: snapshot?.issue?.title ?? '',
    issueNumber: snapshot?.issue?.number ?? env.ISSUE,
  };

  let body: string;
  const status = result.status ?? 'failed';
  if (status === 'rejected') {
    body = renderRejection({
      relevance: relevance ?? { relevance: 'unknown' },
      context,
      templates,
    });
  } else if (status === 'complete' || status === 'partial') {
    const parsed = parseAnswerOrError(answerRaw);
    if (parsed.ok) {
      body = renderAnswer({
        answer: parsed.answer,
        config: repoCfg,
        context,
        templates,
        partial: status === 'partial' ? true : undefined,
      });
    } else {
      body = renderFailure({ reason: `结构化结论无效: ${parsed.error}`, context });
    }
  } else {
    body = renderFailure({ reason: result.reason ?? '', context });
  }

  const path = join(dirs.outputs, 'comment.md');
  writeTextFile(path, body);
  return { rendered: true, reason: status, path };
}

type ParsedAnswer =
  | { readonly ok: true; readonly answer: Answer }
  | { readonly ok: false; readonly error: string };

function parseAnswerOrError(raw: unknown): ParsedAnswer {
  if (raw === undefined) {
    return { ok: false, error: 'answer.json 缺失' };
  }
  try {
    return { ok: true, answer: parseAnswer(raw) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function main(): Promise<void> {
  const outcome = runRender({ env: readRenderEnv(), dirs: resolveDirs() });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

if (isJobEntry('render')) {
  await main();
}
