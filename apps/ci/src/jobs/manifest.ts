/**
 * manifest：生成 `inputs/code_manifest.json`。
 *
 * worktree 由工作流用 git 准备（缓存与 worktree 复用放在 YAML 里更直观），这一步只做
 * 确定性的清点与路径归一化。
 */
import { join } from 'node:path';

import { buildManifest, writeManifest, type SnapshotRefs } from '@gt6ce/agent';
import { loadReposConfig, resolveRepoConfig } from '@gt6ce/shared';

import {
  isJobEntry,
  logStageDirs,
  optionalEnv,
  readJsonFile,
  resolveDirs,
  type StageDirs,
} from '../common.ts';

export interface ManifestOptions {
  readonly dirs: StageDirs;
  readonly repo?: string;
}

export interface ManifestSummary {
  readonly gt6ce: number;
  readonly golden: number;
  readonly history: number[];
  readonly extra: number[];
  readonly auxiliary: number[];
}

export function runManifest(options: ManifestOptions): ManifestSummary {
  const snapshot =
    readJsonFile<SnapshotRefs>(join(options.dirs.inputs, 'snapshot.json')) ?? {};

  let auxiliary: readonly string[] = [];
  if (options.repo) {
    try {
      const config = loadReposConfig(options.dirs.config);
      auxiliary = resolveRepoConfig(config, options.repo).auxiliary_materials;
    } catch {
      // 仓库未登记时仍生成清单，只是没有 auxiliary；gate 已经做过白名单校验。
      auxiliary = [];
    }
  }

  const manifest = buildManifest({
    root: options.dirs.root,
    snapshot,
    auxiliaryMaterials: auxiliary,
  });
  writeManifest(join(options.dirs.inputs, 'code_manifest.json'), manifest);

  return {
    gt6ce: manifest.gt6ce.files.length,
    golden: manifest.golden?.files.length ?? 0,
    history: manifest.history.map((item) => item.files.length),
    extra: manifest.extra.map((item) => item.files.length),
    auxiliary: manifest.auxiliary.map((item) => item.files.length),
  };
}

export async function main(): Promise<void> {
  const dirs = resolveDirs();
  logStageDirs('manifest', dirs);
  const summary = runManifest({ dirs, repo: optionalEnv(process.env, 'REPO') });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (isJobEntry('manifest')) {
  await main();
}
