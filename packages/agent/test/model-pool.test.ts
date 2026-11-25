import { ModelsConfigSchema, type ModelPoolBudget } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import {
  ModelError,
  apiKeyFor,
  bindings,
  candidates,
  emptyHealthState,
  isAvailable,
  loadPool,
  markFailure,
  markSuccess,
  markUsed,
  retryWaitSeconds,
  toModelError,
} from '../src/model-pool.ts';

const BUDGET: ModelPoolBudget = {
  early_base_minutes: 15,
  early_max_minutes: 1440,
  late_base_minutes: 5,
  late_max_minutes: 360,
  rate_limit_retries: 5,
  acp_retries: 1,
  rate_limit_wait_seconds: 60,
  rate_limit_min_wait_seconds: 5,
  rate_limit_max_wait_seconds: 300,
};

const CONFIG = ModelsConfigSchema.parse({
  pools: {
    shared: {
      endpoints: [
        {
          id: 'alpha',
          provider: 'test',
          base_url: 'https://alpha.test/v1',
          api_key_env: 'MODEL_KEY_ALPHA',
          model: 'alpha-model',
        },
        {
          id: 'beta',
          provider: 'test',
          base_url: 'https://beta.test/v1',
          api_key_env: 'MODEL_KEY_BETA',
          model: 'beta-model',
        },
      ],
      roles: {
        analysis: [
          { endpoint: 'alpha', weight: 2 },
          { endpoint: 'beta', weight: 1 },
        ],
      },
    },
  },
});

const ENV = { MODEL_KEY_ALPHA: 'a', MODEL_KEY_BETA: 'b' } as NodeJS.ProcessEnv;
const NOW = new Date('2026-11-16T10:00:00Z');

function pool() {
  return loadPool(CONFIG, 'shared');
}

describe('bindings', () => {
  it('合并 endpoint 与 role 参数，按权重降序', () => {
    const entries = bindings(pool(), 'analysis');
    expect(entries.map((entry) => entry.id)).toEqual(['alpha', 'beta']);
    expect(entries[0]?.weight).toBe(2);
    expect(entries[0]?.model).toBe('alpha-model');
    expect(entries[0]?.role).toBe('analysis');
  });

  it('未知模型池抛 config 错误', () => {
    expect(() => loadPool(CONFIG, 'missing')).toThrowError(ModelError);
  });

  it('apiKeyFor 只从传入的 env 读取', () => {
    const entries = bindings(pool(), 'analysis');
    expect(apiKeyFor(entries[0]!, ENV)).toBe('a');
    expect(apiKeyFor(entries[0]!, {} as NodeJS.ProcessEnv)).toBe('');
  });
});

describe('candidates', () => {
  it('权重相同时优先最久未用', () => {
    const state = emptyHealthState();
    const entries = bindings(pool(), 'analysis');
    markUsed(state, entries[0]!, NOW);
    const ordered = candidates(pool(), 'analysis', state, {
      env: ENV,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(ordered.map((entry) => entry.id)).toEqual(['beta', 'alpha']);
  });

  it('缺少 key 的入口被排除', () => {
    const state = emptyHealthState();
    const ordered = candidates(pool(), 'analysis', state, {
      env: { MODEL_KEY_BETA: 'b' } as NodeJS.ProcessEnv,
      now: NOW,
    });
    expect(ordered.map((entry) => entry.id)).toEqual(['beta']);
  });

  it('requireKey=false 时不看环境变量', () => {
    const ordered = candidates(pool(), 'analysis', emptyHealthState(), {
      requireKey: false,
      env: {} as NodeJS.ProcessEnv,
      now: NOW,
    });
    expect(ordered).toHaveLength(2);
  });
});

describe('健康状态与退避', () => {
  it('429 让入口进入冷却并在窗口内被排除', () => {
    const state = emptyHealthState();
    const [alpha] = bindings(pool(), 'analysis');
    markFailure(state, alpha!, new ModelError('rate', 429, 0, ''), BUDGET, NOW);

    const item = state.endpoints.alpha;
    expect(item?.status).toBe('cooldown');
    expect(item?.reason).toBe('rate');
    expect(item?.until).toBe('2026-11-16T10:05:00.000Z');
    expect(isAvailable(alpha!, state, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(
      candidates(pool(), 'analysis', state, {
        env: ENV,
        now: new Date(NOW.getTime() + 60_000),
      }).map((entry) => entry.id),
    ).toEqual(['beta']);
  });

  it('冷却到期后重新可用', () => {
    const state = emptyHealthState();
    const [alpha] = bindings(pool(), 'analysis');
    markFailure(state, alpha!, new ModelError('rate', 429, 0, ''), BUDGET, NOW);
    expect(isAvailable(alpha!, state, new Date(NOW.getTime() + 6 * 60_000))).toBe(true);
    expect(state.endpoints.alpha?.status).toBe('ok');
  });

  it('连续失败按 2^(n-1) 增长并封顶为 disabled', () => {
    const state = emptyHealthState();
    const [alpha] = bindings(pool(), 'analysis');
    const budget: ModelPoolBudget = { ...BUDGET, late_max_minutes: 12 };

    markFailure(state, alpha!, new ModelError('rate', 429, 0, ''), budget, NOW);
    expect(state.endpoints.alpha?.until).toBe('2026-11-16T10:05:00.000Z');

    markFailure(state, alpha!, new ModelError('rate', 429, 0, ''), budget, NOW);
    expect(state.endpoints.alpha?.until).toBe('2026-11-16T10:10:00.000Z');

    markFailure(state, alpha!, new ModelError('rate', 429, 0, ''), budget, NOW);
    expect(state.endpoints.alpha?.status).toBe('disabled');
  });

  it('Retry-After 抬升晚期错误的基数', () => {
    const state = emptyHealthState();
    const [alpha] = bindings(pool(), 'analysis');
    markFailure(state, alpha!, new ModelError('rate', 429, 600, ''), BUDGET, NOW);
    expect(state.endpoints.alpha?.until).toBe('2026-11-16T10:10:00.000Z');
  });

  it('成功清零计数与冷却', () => {
    const state = emptyHealthState();
    const [alpha] = bindings(pool(), 'analysis');
    markFailure(state, alpha!, new ModelError('rate', 429, 0, ''), BUDGET, NOW);
    markSuccess(state, alpha!, NOW);
    expect(state.endpoints.alpha).toMatchObject({ status: 'ok', failures: 0 });
    expect(state.endpoints.alpha?.until).toBeUndefined();
  });

  it('retryWaitSeconds 取服务端要求与本地区间的交集', () => {
    expect(retryWaitSeconds(new ModelError('rate', 429, 120, ''), BUDGET)).toBe(120);
    expect(retryWaitSeconds(new ModelError('rate', 429, 1, ''), BUDGET)).toBe(5);
    expect(retryWaitSeconds(new ModelError('rate', 429, 9999, ''), BUDGET)).toBe(300);
    expect(retryWaitSeconds(new ModelError('rate', 429, 0, ''), BUDGET)).toBe(60);
  });
});

describe('toModelError', () => {
  it('按状态码分类并解析 Retry-After', () => {
    expect(toModelError({ statusCode: 401 }).kind).toBe('auth');
    expect(toModelError({ statusCode: 403 }).kind).toBe('auth');
    expect(toModelError({ statusCode: 404 }).kind).toBe('config');
    expect(toModelError({ statusCode: 500 }).kind).toBe('upstream');
    const rate = toModelError({ statusCode: 429, responseHeaders: { 'retry-after': '42' } });
    expect(rate.kind).toBe('rate');
    expect(rate.retryAfterSeconds).toBe(42);
    expect(toModelError(new Error('socket hang up')).kind).toBe('network');
  });

  it('本地文件系统错误码归为 config', () => {
    for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'ENOTDIR', 'EISDIR']) {
      const error = Object.assign(new Error(`${code}: local filesystem failure`), { code });
      expect(toModelError(error)).toMatchObject({ kind: 'config', status: 0 });
    }
  });

  it('HTTP 状态码优先于文件系统错误码', () => {
    const error = Object.assign(new Error('upstream failed'), {
      statusCode: 503,
      code: 'EACCES',
    });
    expect(toModelError(error).kind).toBe('upstream');
  });

  it('已是 ModelError 时原样返回', () => {
    const error = new ModelError('upstream', 502, 0, 'boom');
    expect(toModelError(error)).toBe(error);
  });
});
