import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelError as ModelErrorType } from '@gt6ce/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  draftIssue: vi.fn(),
  createChatModel: vi.fn((target: { model: string }) => ({ modelId: target.model })),
}));

// 只替换「发请求」这一步：模型池调度、失败计数与冷却都是真实实现。
vi.mock('@gt6ce/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gt6ce/agent')>();
  return {
    ...actual,
    draftIssue: mocks.draftIssue,
    createChatModel: mocks.createChatModel,
  };
});

const { AgentError, emptyHealthState } = await import('@gt6ce/agent');
const { loadBudgetsConfig, parseModelsConfig, parseReposConfig } = await import('@gt6ce/shared');
const { createDraftExecutor } = await import('../src/executor.ts');

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const REPOS = parseReposConfig({
  bot: { login: 'bot[bot]', mention: '@bot' },
  repos: { 'o/r': { code_repo: 'o/r' } },
});

/** 两个入口同权重，候选顺序按 id 升序：`a` 先试，失败后轮到 `b`。 */
const MODELS = parseModelsConfig({
  pools: {
    shared: {
      endpoints: [
        {
          id: 'a',
          provider: 'p',
          base_url: 'https://a.test/v1',
          api_key_env: 'MODEL_KEY_A',
          model: 'model-a',
        },
        {
          id: 'b',
          provider: 'p',
          base_url: 'https://b.test/v1',
          api_key_env: 'MODEL_KEY_B',
          model: 'model-b',
        },
      ],
      roles: { analysis: [{ endpoint: 'a' }, { endpoint: 'b' }] },
    },
  },
});

const ENV = { MODEL_KEY_A: 'key-a', MODEL_KEY_B: 'key-b' };

const REQUEST = {
  kind: 'issue-draft' as const,
  repo: 'o/r',
  scope: 'group:g',
  requester: 'u',
  draft: {
    title: '合成器崩溃',
    version: '1.21.1',
    steps: '打开合成器',
    expected: '正常显示',
  },
};

const DRAFT = {
  title: '合成器在 1.21.1 崩溃',
  body: '## 现象\n\n崩溃。',
  labels: ['bug'],
};

function executor(options: { timeoutMs?: number; health?: ReturnType<typeof emptyHealthState> } = {}) {
  return createDraftExecutor({
    repos: REPOS,
    models: MODELS,
    budgets: loadBudgetsConfig(join(REPO_ROOT, 'config')),
    promptsDir: join(REPO_ROOT, 'prompts'),
    env: ENV,
    pool: 'shared',
    role: 'analysis',
    temperature: 0.2,
    maxOutputTokens: 1000,
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.health ? { health: options.health } : {}),
  });
}

interface DraftCall {
  readonly model: { readonly modelId: string };
  readonly abortSignal?: AbortSignal;
}

function callAt(index: number): DraftCall {
  return mocks.draftIssue.mock.calls[index]?.[0] as DraftCall;
}

afterEach(() => {
  mocks.draftIssue.mockReset();
  mocks.createChatModel.mockClear();
});

describe('createDraftExecutor 单入口超时', () => {
  it('一个入口挂住时按单次超时中止并切换下一个候选', async () => {
    const health = emptyHealthState();
    mocks.draftIssue.mockImplementation((options: DraftCall) => {
      if (options.model.modelId === 'model-a') {
        // 模拟只对 abort 有反应的 provider：不主动返回，也不主动报错。
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        });
      }
      return Promise.resolve(DRAFT);
    });

    const draft = await executor({ timeoutMs: 40, health })(REQUEST, new AbortController().signal);

    expect(draft).toEqual(DRAFT);
    expect(mocks.draftIssue).toHaveBeenCalledTimes(2);
    // 只淘汰挂住的那个入口：它的信号被单次超时中止，第二个入口拿到的是未中止的信号。
    expect(callAt(0).model.modelId).toBe('model-a');
    expect(callAt(0).abortSignal?.aborted).toBe(true);
    expect(callAt(1).model.modelId).toBe('model-b');
    expect(callAt(1).abortSignal?.aborted).toBe(false);
    expect(health.endpoints.a).toMatchObject({ status: 'cooldown', reason: 'network' });
    expect(health.endpoints.b?.status).toBe('ok');
  });

  it('整体截止时间已到时不再尝试后续入口', async () => {
    const health = emptyHealthState();
    const controller = new AbortController();
    controller.abort();

    await expect(executor({ health })(REQUEST, controller.signal)).rejects.toBeInstanceOf(
      AgentError,
    );

    expect(mocks.draftIssue).not.toHaveBeenCalled();
    // 没有被调用过的入口只被 candidates 建了空记录，不应记上任何失败。
    expect(health.endpoints.a?.status).toBeUndefined();
    expect(health.endpoints.a?.failures).toBeUndefined();
  });

  it('整体截止时间在调用中到达时不把入口记成失败', async () => {
    const health = emptyHealthState();
    mocks.draftIssue.mockImplementation(
      (options: DraftCall) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = executor({ timeoutMs: 10_000, health })(REQUEST, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeInstanceOf(AgentError);

    // 只有第一个入口被调用过；整体中止不是入口故障，不应写入冷却。
    expect(mocks.draftIssue).toHaveBeenCalledTimes(1);
    expect(health.endpoints.a?.failures).toBeUndefined();
    expect(health.endpoints.a?.status).toBeUndefined();
  });

  it('非超时失败同样按候选顺序切换，全部失败时抛最后一个 ModelError', async () => {
    const health = emptyHealthState();
    mocks.draftIssue.mockRejectedValue(
      Object.assign(new Error('rate limited'), {
        statusCode: 429,
        responseHeaders: { 'retry-after': '60' },
      }),
    );

    await expect(executor({ health })(REQUEST, new AbortController().signal)).rejects.toMatchObject(
      { kind: 'rate', status: 429 } satisfies Partial<ModelErrorType>,
    );

    expect(mocks.draftIssue).toHaveBeenCalledTimes(2);
    expect(health.endpoints.a).toMatchObject({ status: 'cooldown', reason: 'rate' });
    expect(health.endpoints.b).toMatchObject({ status: 'cooldown', reason: 'rate' });
  });
});
