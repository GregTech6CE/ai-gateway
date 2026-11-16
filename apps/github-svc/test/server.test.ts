import type { AddressInfo } from 'node:net';

import type { FetchLike } from '@gt6ce/github';
import { createLogger, parseReposConfig } from '@gt6ce/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitHubSvcConfig } from '../src/config.ts';
import { StaticTokenProvider } from '../src/github-auth.ts';
import { IdempotencyCache } from '../src/idempotency.ts';
import { IssueService } from '../src/issues.ts';
import { createGitHubSvcServer } from '../src/server.ts';

const REPOS = parseReposConfig({
  bot: { login: 'bot[bot]', mention: '@bot' },
  repos: {
    'o/r': { code_repo: 'o/r' },
  },
});

const CONFIG: GitHubSvcConfig = {
  server: { host: '127.0.0.1', port: 0 },
  token: 'svc-token',
  configDir: '/tmp',
  github: { mode: 'token', token: 'gh-token' },
  issues: { ttlMs: 60_000, maxEntries: 10, timeoutMs: 1_000 },
};

const BODY = {
  requestId: 'session-1',
  repo: 'o/r',
  title: '合成器崩溃',
  body: '打开合成器即崩溃。',
  labels: ['bug'],
};

const AUTH = { authorization: 'Bearer svc-token', 'content-type': 'application/json' };
const logger = createLogger({ sink: () => undefined });

interface Mock {
  readonly fetchImpl: FetchLike;
  calls: number;
}

function githubMock(status = 201): Mock {
  const mock: Mock = {
    calls: 0,
    fetchImpl: async () => {
      mock.calls += 1;
      if (status >= 400) {
        return new Response(JSON.stringify({ message: 'boom' }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/issues/7' }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    },
  };
  return mock;
}

interface Harness {
  readonly base: string;
  readonly mock: Mock;
  readonly close: () => Promise<void>;
}

const opened: Harness[] = [];

async function harness(mock: Mock = githubMock()): Promise<Harness> {
  const service = new IssueService({
    repos: REPOS,
    tokenProvider: new StaticTokenProvider('gh-token'),
    idempotency: new IdempotencyCache({ ttlMs: 60_000, maxEntries: 10 }),
    logger,
    fetchImpl: mock.fetchImpl,
    baseUrl: 'https://api.test',
    timeoutMs: 1_000,
  });
  const server = createGitHubSvcServer({ config: CONFIG, issues: service, logger });
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
    mock,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
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

describe('github-svc 鉴权与健康检查', () => {
  it('healthz 免鉴权', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('缺少或错误的 token 返回 401', async () => {
    const app = await harness();

    const missing = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    const wrong = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: { ...AUTH, authorization: 'Bearer wrong' },
      body: JSON.stringify(BODY),
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(app.mock.calls).toBe(0);
  });
});

describe('github-svc 入站校验', () => {
  it('非法 JSON、缺字段、未知仓库都拒绝', async () => {
    const app = await harness();

    const broken = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: '{oops',
    });
    const invalid = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ requestId: 'x' }),
    });
    const forbidden = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ ...BODY, repo: 'o/unknown' }),
    });

    expect(broken.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'repo_forbidden' });
    expect(app.mock.calls).toBe(0);
  });

  it('命中凭据扫描返回 422，且不调用 GitHub', async () => {
    const app = await harness();
    const response = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        ...BODY,
        body: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'sensitive_content' });
    expect(app.mock.calls).toBe(0);
  });

  it('未知路由 404、方法不符 405', async () => {
    const app = await harness();

    const notFound = await fetch(`${app.base}/nope`, { headers: AUTH });
    const wrongMethod = await fetch(`${app.base}/issues`, { headers: AUTH });

    expect(notFound.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
  });
});

describe('github-svc 创建与幂等', () => {
  it('创建成功返回 201，重复 requestId 返回 200 且不再调用 GitHub', async () => {
    const app = await harness();

    const first = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    const second = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      number: 7,
      url: 'https://github.com/o/r/issues/7',
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      number: 7,
      url: 'https://github.com/o/r/issues/7',
    });
    expect(app.mock.calls).toBe(1);
  });

  it('GitHub 失败返回 502，响应不含上游细节', async () => {
    const app = await harness(githubMock(500));
    const response = await fetch(`${app.base}/issues`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(response.status).toBe(502);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ code: 'github_error' });
    expect(JSON.stringify(payload)).not.toContain('boom');
  });
});
