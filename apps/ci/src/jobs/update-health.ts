/**
 * update-health：把本轮模型健康状态写回仓库变量 `MODEL_HEALTH`。
 *
 * 变量不存在时回退为创建；判定依据是状态码 404，不解析错误文本。
 * 失败不让 finalize 失败——健康状态是下一轮的提示，不是本轮产物的一部分。
 */
import { join } from 'node:path';

import { GitHubClient, type FetchLike } from '@gt6ce/github';
import { GitHubApiError } from '@gt6ce/shared';

import {
  errorMessage,
  isJobEntry,
  optionalEnv,
  readJsonFile,
  requireEnv,
  resolveDirs,
  type StageDirs,
} from '../common.ts';

export interface UpdateHealthEnv {
  readonly MODEL_HEALTH_TOKEN: string;
  readonly B_REPO: string;
  readonly MODEL_HEALTH_PATH: string;
}

export function readUpdateHealthEnv(source: NodeJS.ProcessEnv = process.env): UpdateHealthEnv {
  return {
    MODEL_HEALTH_TOKEN: requireEnv(source, 'MODEL_HEALTH_TOKEN'),
    B_REPO: requireEnv(source, 'B_REPO'),
    MODEL_HEALTH_PATH: optionalEnv(source, 'MODEL_HEALTH_PATH') || 'outputs/model_health.json',
  };
}

interface HealthShape {
  readonly endpoints?: Record<string, unknown>;
}

export interface UpdateHealthOptions {
  readonly env: UpdateHealthEnv;
  readonly dirs: StageDirs;
  readonly fetchImpl?: FetchLike;
}

export interface UpdateHealthOutcome {
  readonly updated: boolean;
  readonly endpoints: number;
  readonly reason?: string;
}

export async function runUpdateHealth(
  options: UpdateHealthOptions,
): Promise<UpdateHealthOutcome> {
  const { env, dirs } = options;
  const path = env.MODEL_HEALTH_PATH.startsWith('/') ||
    /^[A-Za-z]:/.test(env.MODEL_HEALTH_PATH)
    ? env.MODEL_HEALTH_PATH
    : join(dirs.root, env.MODEL_HEALTH_PATH);

  const state = readJsonFile<HealthShape>(path);
  if (!state) {
    return { updated: false, endpoints: 0, reason: `${env.MODEL_HEALTH_PATH} 缺失或不可解析` };
  }
  const endpoints = Object.keys(state.endpoints ?? {}).length;
  if (endpoints === 0) {
    return { updated: false, endpoints: 0, reason: '没有 endpoint 状态' };
  }

  const api = new GitHubClient({ token: env.MODEL_HEALTH_TOKEN, fetchImpl: options.fetchImpl });
  const body = { name: 'MODEL_HEALTH', value: JSON.stringify(state) };
  try {
    await api.request('PATCH', `/repos/${env.B_REPO}/actions/variables/MODEL_HEALTH`, body);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      await api.request('POST', `/repos/${env.B_REPO}/actions/variables`, body);
    } else {
      return { updated: false, endpoints, reason: errorMessage(error) };
    }
  }
  return { updated: true, endpoints };
}

export async function main(): Promise<void> {
  try {
    const outcome = await runUpdateHealth({
      env: readUpdateHealthEnv(),
      dirs: resolveDirs(),
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } catch (error) {
    process.stderr.write(`update-health failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (isJobEntry('update-health')) {
  await main();
}
