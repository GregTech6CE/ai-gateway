import type { AddressInfo } from 'node:net';

import { ModelError } from '@gt6ce/agent';
import { createLogger, parseReposConfig } from '@gt6ce/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentSvcConfig } from '../src/config.ts';
import type { DraftExecutor } from '../src/contracts.ts';
import { TaskRunner } from '../src/runner.ts';
import { createAgentSvcServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';

const REPOS = parseReposConfig({
  bot: { login: 'bot[bot]', mention: '@bot' },
  repos: {
    'o/r': { code_repo: 'o/r' },
    'o/disabled': { code_repo: 'o/r', enabled: false },
  },
});

const CONFIG: AgentSvcConfig = {
  server: { host: '127.0.0.1', port: 0 },
  token: 'svc-token',
  configDir: '/tmp',
  promptsDir: '/tmp',
  model: { pool: 'shared', role: 'analysis', temperature: 0.2, maxOutputTokens: 1000, timeoutMs: 1000 },
  tasks: { concurrency: 1, ttlMs: 60_000, maxTasks: 10, timeoutMs: 1000 },
};

const BODY = {
  kind: 'issue-draft',
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

const AUTH = { authorization: 'Bearer svc-token', 'content-type': 'application/json' };

const logger = createLogger({ sink: () => undefined });

interface Harness {
  readonly base: string;
  readonly tasks: TaskStore;
  readonly close: () => Promise<void>;
}

const opened: Harness[] = [];

async function harness(options: {
  executor?: DraftExecutor;
  timeoutMs?: number;
  tasks?: TaskStore;
} = {}): Promise<Harness> {
  const tasks =
    options.tasks ?? new TaskStore({ ttlMs: 60_000, maxTasks: 10, idFactory: (() => {
      let n = 0;
      return () => `task-${(n += 1)}`;
    })() });
  const executor = options.executor ?? (async () => DRAFT);
  const runner = new TaskRunner({
    store: tasks,
    executor,
    concurrency: 1,
    timeoutMs: options.timeoutMs ?? 1000,
    logger,
  });
  const server = createAgentSvcServer({
    config: CONFIG,
    repos: REPOS,
    tasks,
    enqueue: (taskId) => {
      runner.enqueue(taskId);
    },
    logger,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const entry: Harness = {
    base: `http://127.0.0.1:${address.port}`,
    tasks,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await runner.stop(100);
    },
  };
  opened.push(entry);
  return entry;
}

afterEach(async () => {
  while (opened.length > 0) {
    await opened.pop()?.close();
  }
});

async function waitFor(base: string, taskId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/tasks/${taskId}`, { headers: AUTH });
    const snapshot = (await response.json()) as Record<string, unknown>;
    if (snapshot.status === 'succeeded' || snapshot.status === 'failed') {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('任务在预期时间内没有结束');
}

describe('agent-svc 鉴权与健康检查', () => {
  it('healthz 免鉴权', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('缺少或错误的 Bearer token 返回 401', async () => {
    const app = await harness();

    const missing = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    const wrong = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: { ...AUTH, authorization: 'Bearer wrong' },
      body: JSON.stringify(BODY),
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: 'unauthorized' });
  });
});

describe('agent-svc 入站校验', () => {
  it('非法 JSON 与不符合契约的 body 都是 400', async () => {
    const app = await harness();

    const broken = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: '{oops',
    });
    const invalid = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ kind: 'issue-draft' }),
    });

    expect(broken.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_body' });
  });

  it('未登记仓库返回 403', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ ...BODY, repo: 'o/unknown' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'repo_forbidden' });
  });

  it('已登记但未启用的仓库返回 403', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ ...BODY, repo: 'o/disabled' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'repo_disabled' });
  });

  it('未知路由 404、方法不符 405', async () => {
    const app = await harness();

    const notFound = await fetch(`${app.base}/nope`, { headers: AUTH });
    const wrongMethod = await fetch(`${app.base}/tasks`, { headers: AUTH });

    expect(notFound.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
  });
});

describe('agent-svc 任务流转', () => {
  it('受理后返回 202，轮询到 succeeded 并带结构化草稿', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { taskId: string };
    expect(accepted.taskId).toMatch(/^task-/);

    const snapshot = await waitFor(app.base, accepted.taskId);
    expect(snapshot).toEqual({
      id: accepted.taskId,
      status: 'succeeded',
      result: DRAFT,
    });
  });

  it('执行器失败时写入稳定文案，不泄露堆栈', async () => {
    const app = await harness({
      executor: async () => {
        throw new ModelError('rate', 429, 30, 'upstream said secret');
      },
    });
    const response = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    const accepted = (await response.json()) as { taskId: string };

    const snapshot = await waitFor(app.base, accepted.taskId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toBe('模型服务不可用（rate）');
    expect(JSON.stringify(snapshot)).not.toContain('upstream said secret');
    expect(JSON.stringify(snapshot)).not.toContain('stack');
  });

  it('执行超时标记 failed 为「分析超时」', async () => {
    const app = await harness({
      timeoutMs: 50,
      executor: () => new Promise(() => undefined),
    });
    const response = await fetch(`${app.base}/tasks`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    const accepted = (await response.json()) as { taskId: string };

    const snapshot = await waitFor(app.base, accepted.taskId);
    expect(snapshot).toMatchObject({ status: 'failed', error: '分析超时' });
  });

  it('未知任务 id 返回 404', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/tasks/not-exist`, { headers: AUTH });

    expect(response.status).toBe(404);
  });

  it('任务 id 中的路径分隔符被编码后仍按 id 查询', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/tasks/a%2Fb`, { headers: AUTH });

    expect(response.status).toBe(404);
  });
});
