import type { FetchLike } from '@gt6ce/github';
import { createLogger, parseReposConfig, resolveRepoConfig } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import type { CreateIssueRequest } from '../src/contracts.ts';
import { StaticTokenProvider } from '../src/github-auth.ts';
import { IdempotencyCache } from '../src/idempotency.ts';
import { IssueService, IssueServiceError, resolveLabels } from '../src/issues.ts';

const REPOS = parseReposConfig({
  bot: { login: 'bot[bot]', mention: '@bot' },
  repos: {
    'o/r': {
      code_repo: 'o/r',
      triage: {
        label_axes: {
          type: ['bug'],
          kind: ['crash'],
          scope: ['scope: machine'],
        },
        label_limits: { type: 1, kind: 2, scope: 1 },
      },
    },
    'o/disabled': { code_repo: 'o/r', enabled: false },
  },
});

const REQUEST: CreateIssueRequest = {
  requestId: 'session-1',
  repo: 'o/r',
  title: '合成器崩溃',
  body: '## 现象\n\n打开合成器即崩溃。',
  labels: ['bug', 'crash', 'not-allowed'],
};

const logger = createLogger({ sink: () => undefined });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface GitHubMock {
  readonly fetchImpl: FetchLike;
  readonly calls: Array<{ url: string; body: Record<string, unknown> | undefined }>;
}

function githubMock(options: { rejectLabels?: boolean; fail?: boolean } = {}): GitHubMock {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, body });
    if (options.fail) {
      return json(500, { message: 'boom' });
    }
    const labels = body?.labels;
    if (options.rejectLabels && Array.isArray(labels) && labels.length > 0) {
      return json(422, { message: 'Validation Failed' });
    }
    return json(201, { number: 7, html_url: 'https://github.com/o/r/issues/7' });
  };
  return { fetchImpl, calls };
}

function serviceWith(fetchImpl: FetchLike): {
  service: IssueService;
  idempotency: IdempotencyCache;
} {
  const idempotency = new IdempotencyCache({ ttlMs: 60_000, maxEntries: 10 });
  const service = new IssueService({
    repos: REPOS,
    tokenProvider: new StaticTokenProvider('gh-token'),
    idempotency,
    logger,
    fetchImpl,
    baseUrl: 'https://api.test',
    timeoutMs: 1_000,
  });
  return { service, idempotency };
}

describe('resolveLabels', () => {
  const repo = resolveRepoConfig(REPOS, 'o/r');

  it('保留合法标签，丢弃未知标签并回填类型', () => {
    expect(resolveLabels(repo, ['bug', 'crash', 'not-allowed'])).toEqual(['crash', 'bug']);
  });

  it('没有类型时性质标签一并丢弃', () => {
    expect(resolveLabels(repo, ['crash'])).toEqual([]);
  });

  it('只有类型标签时只保留类型', () => {
    expect(resolveLabels(repo, ['bug'])).toEqual(['bug']);
  });

  it('空标签返回空数组', () => {
    expect(resolveLabels(repo, [])).toEqual([]);
  });
});

describe('IssueService', () => {
  it('清洗标签后创建 Issue', async () => {
    const mock = githubMock();
    const { service } = serviceWith(mock.fetchImpl);

    const outcome = await service.create(REQUEST);

    expect(outcome.replayed).toBe(false);
    expect(outcome.issue).toEqual({ number: 7, url: 'https://github.com/o/r/issues/7' });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe('https://api.test/repos/o/r/issues');
    expect(mock.calls[0]?.body).toMatchObject({
      title: REQUEST.title,
      body: REQUEST.body,
      labels: ['crash', 'bug'],
    });
  });

  it('相同 requestId 命中缓存，不再调用 GitHub', async () => {
    const mock = githubMock();
    const { service } = serviceWith(mock.fetchImpl);

    const first = await service.create(REQUEST);
    const second = await service.create(REQUEST);

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ issue: first.issue, replayed: true });
    expect(mock.calls).toHaveLength(1);
  });

  it('并发相同 requestId 也只创建一次', async () => {
    const mock = githubMock();
    const { service } = serviceWith(mock.fetchImpl);

    const [first, second] = await Promise.all([service.create(REQUEST), service.create(REQUEST)]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(mock.calls).toHaveLength(1);
  });

  it('未登记或未启用的仓库在调用 GitHub 前就拒绝', async () => {
    const mock = githubMock();
    const { service } = serviceWith(mock.fetchImpl);

    await expect(service.create({ ...REQUEST, repo: 'o/unknown' })).rejects.toMatchObject({
      status: 403,
      code: 'repo_forbidden',
    });
    await expect(service.create({ ...REQUEST, repo: 'o/disabled' })).rejects.toMatchObject({
      status: 403,
      code: 'repo_disabled',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('标题或正文命中凭据扫描时拒绝，不调用 GitHub', async () => {
    const mock = githubMock();
    const { service } = serviceWith(mock.fetchImpl);

    const failure = service.create({
      ...REQUEST,
      body: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });

    await expect(failure).rejects.toBeInstanceOf(IssueServiceError);
    await expect(failure).rejects.toMatchObject({ status: 422, code: 'sensitive_content' });
    expect(mock.calls).toHaveLength(0);
  });

  it('标签被 GitHub 拒绝时去掉标签重试一次', async () => {
    const mock = githubMock({ rejectLabels: true });
    const { service } = serviceWith(mock.fetchImpl);

    const outcome = await service.create(REQUEST);

    expect(outcome.issue.number).toBe(7);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.body).not.toHaveProperty('labels');
  });

  it('GitHub 5xx 映射为 502，不泄露响应体', async () => {
    const mock = githubMock({ fail: true });
    const { service } = serviceWith(mock.fetchImpl);

    const failure = service.create(REQUEST);

    await expect(failure).rejects.toMatchObject({ status: 502, code: 'github_error' });
    await expect(failure).rejects.not.toThrow(/boom/);
  });
});
