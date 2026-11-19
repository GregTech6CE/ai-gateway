/**
 * prefetch：下载并解压 issue 附件，生成日志摘要。
 *
 * 只读 `inputs/snapshot.json` 与 `config/budgets.json`；不接触任何凭据。
 */
import { join } from 'node:path';

import { prefetchAttachments, type FetchLike, type PrefetchResult } from '@gt6ce/agent';
import { loadBudgetsConfig } from '@gt6ce/shared';

import { isJobEntry, logStageDirs, readJsonFile, resolveDirs, type StageDirs } from '../common.ts';

interface SnapshotShape {
  readonly attachments?: readonly string[];
}

export interface PrefetchOptions {
  readonly dirs: StageDirs;
  readonly fetchImpl?: FetchLike;
}

export async function runPrefetch(options: PrefetchOptions): Promise<PrefetchResult> {
  const snapshot = readJsonFile<SnapshotShape>(join(options.dirs.inputs, 'snapshot.json'));
  if (!snapshot) {
    throw new Error('inputs/snapshot.json 缺失，无法预取附件');
  }
  const budgets = loadBudgetsConfig(options.dirs.config).defaults;
  return await prefetchAttachments({
    root: options.dirs.root,
    attachments: snapshot.attachments ?? [],
    limits: {
      maxAttachmentBytes: budgets.artifacts.max_attachment_bytes,
      maxTotalAttachmentBytes: budgets.artifacts.max_total_attachment_bytes,
    },
    fetchImpl: options.fetchImpl,
  });
}

export async function main(): Promise<void> {
  const dirs = resolveDirs();
  logStageDirs('prefetch', dirs);
  const result = await runPrefetch({ dirs });
  for (const note of result.notes) {
    process.stdout.write(`${note}\n`);
  }
}

if (isJobEntry('prefetch')) {
  await main();
}
