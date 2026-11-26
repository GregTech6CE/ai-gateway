/**
 * `@gt6ce/ci` 的统一入口：按子命令调度 `dist/jobs/<name>.js` 的同一份实现。
 *
 * 两种调用方式等价：
 * - `node dist/jobs/gate.js`
 * - `node dist/index.js gate`
 *
 * 每个 job 的 guard 比对入口文件名，因此被本文件静态引入时不会自行执行。
 */
import { isJobEntry } from './common.ts';
import { main as analysisMain } from './jobs/analysis.ts';
import { main as controlMain } from './jobs/control.ts';
import { main as gateMain } from './jobs/gate.ts';
import { main as prefetchMain } from './jobs/prefetch.ts';
import { main as renderMain } from './jobs/render.ts';
import { main as updateHealthMain } from './jobs/update-health.ts';
import { main as writeBackMain } from './jobs/write-back.ts';

export * from './common.ts';
export * from './prompts.ts';
export * from './scan.ts';

export { readGateEnv, runGate } from './jobs/gate.ts';
export type { GateEnv, GateOptions, GateOutcome } from './jobs/gate.ts';

export { readAnalysisEnv, runAnalysis } from './jobs/analysis.ts';
export type {
  AnalysisEnv,
  AnalysisOptions,
  AnalysisOutcome,
  AnalysisStatus,
  ResultPayload,
} from './jobs/analysis.ts';

export { runPrefetch } from './jobs/prefetch.ts';
export type { PrefetchOptions } from './jobs/prefetch.ts';

export { readRenderEnv, runRender } from './jobs/render.ts';
export type { RenderEnv, RenderOptions, RenderOutcome } from './jobs/render.ts';

export { readWriteBackEnv, runWriteBack } from './jobs/write-back.ts';
export type {
  WriteBackAction,
  WriteBackEnv,
  WriteBackOptions,
  WriteBackOutcome,
} from './jobs/write-back.ts';

export { readUpdateHealthEnv, runUpdateHealth } from './jobs/update-health.ts';
export type {
  UpdateHealthEnv,
  UpdateHealthOptions,
  UpdateHealthOutcome,
} from './jobs/update-health.ts';

export { cleanup, downloadArtifactZip, finish, start, waitRun } from './jobs/control.ts';
export type { ControlDeps, ControlEnv, FinishOutcome, StartOutcome } from './jobs/control.ts';

export const PACKAGE_NAME = '@gt6ce/ci';

const COMMANDS: Readonly<Record<string, () => Promise<void>>> = {
  gate: gateMain,
  prefetch: prefetchMain,
  analysis: analysisMain,
  render: renderMain,
  'write-back': writeBackMain,
  'update-health': updateHealthMain,
  control: () => controlMain(process.argv[3]),
};

export async function runCommand(name: string | undefined): Promise<void> {
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    throw new Error(`未知命令: ${name ?? '(空)'}；可用: ${Object.keys(COMMANDS).join(', ')}`);
  }
  await command();
}

if (isJobEntry('index')) {
  await runCommand(process.argv[2]);
}
