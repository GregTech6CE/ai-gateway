/**
 * 模型池执行器：把一次任务变成一次结构化草稿。
 *
 * 调度只做两件事：按「权重 × 待机时长」挑入口，失败后标记冷却并换下一个。429/5xx 的
 * 退避窗口由 `@gt6ce/agent` 的 `markFailure` 维护；在窗口内该入口不会进入候选集。
 */
import {
  AgentError,
  ModelError,
  candidates,
  createChatModel,
  draftIssue,
  emptyHealthState,
  loadPool,
  markFailure,
  markSuccess,
  markUsed,
  toModelError,
  type ModelHealthState,
} from '@gt6ce/agent';
import {
  resolveRepoConfig,
  type BudgetsConfig,
  type ModelsConfig,
  type ReposConfig,
} from '@gt6ce/shared';

import type { DraftExecutor } from './contracts.ts';
import { buildSystemPrompt, buildUserPrompt, loadDraftPrompt } from './prompts.ts';

export interface DraftExecutorOptions {
  readonly repos: ReposConfig;
  readonly models: ModelsConfig;
  readonly budgets: BudgetsConfig;
  readonly promptsDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pool: string;
  readonly role: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly now?: () => Date;
  readonly health?: ModelHealthState;
}

export function createDraftExecutor(options: DraftExecutorOptions): DraftExecutor {
  const pool = loadPool(options.models, options.pool);
  const health = options.health ?? emptyHealthState();
  const now = (): Date => options.now?.() ?? new Date();
  const systemPrompts = new Map<string, string>();

  const systemFor = (repoKey: string, profile: string | undefined): string => {
    const cached = systemPrompts.get(repoKey);
    if (cached !== undefined) {
      return cached;
    }
    const repoCfg = resolveRepoConfig(options.repos, repoKey);
    const system = buildSystemPrompt(loadDraftPrompt(options.promptsDir, profile), repoCfg);
    systemPrompts.set(repoKey, system);
    return system;
  };

  return async (request, signal) => {
    const repoCfg = resolveRepoConfig(options.repos, request.repo);
    const system = systemFor(repoCfg.key, repoCfg.prompt_profile);
    const user = buildUserPrompt(request);
    const entries = candidates(pool, options.role, health, {
      env: options.env,
      now: now(),
    });
    if (entries.length === 0) {
      throw new ModelError('unavailable', 0, 0, '没有可用的模型入口');
    }

    let last: ModelError | undefined;
    for (const entry of entries) {
      const apiKey = options.env[entry.api_key_env] ?? '';
      if (apiKey === '') {
        // candidates 默认要求有 key；这里只是防御，正常不会走到。
        continue;
      }
      markUsed(health, entry, now());
      try {
        const draft = await draftIssue({
          model: createChatModel({
            baseUrl: entry.base_url,
            apiKey,
            model: entry.model,
            headers: entry.headers,
            providerName: entry.provider,
          }),
          system,
          user,
          temperature: options.temperature,
          maxOutputTokens: options.maxOutputTokens,
          abortSignal: signal,
        });
        markSuccess(health, entry, now());
        return draft;
      } catch (error) {
        const modelError = toModelError(error);
        markFailure(health, entry, modelError, options.budgets.defaults.model_pool, now());
        last = modelError;
      }
    }
    throw last ?? new AgentError('所有模型入口都不可用');
  };
}
