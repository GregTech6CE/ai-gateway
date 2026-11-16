import { GitHubApiError, TriageConfigSchema } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import { GitHubClient, type FetchLike } from '../src/client.ts';
import {
  SecretScanBlockedError,
  applyTriage,
  isBotStopLabeled,
  publishComment,
} from '../src/triage.ts';

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function recordingFetch(handler: (call: RecordedCall) => Response): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const rawBody = init?.body;
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: input,
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

const TRIAGE = TriageConfigSchema.parse({
  label_axes: { type: ['bug', 'enhancement'], kind: ['crash', 'perf'], scope: ['scope: machine'] },
  triage_labels: ['needs triage'],
  remove_after_triage: true,
});

describe('publishComment', () => {
  it('有占位评论时 PATCH', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { id: 77 }));
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await publishComment({
      api,
      repo: 'o/r',
      issueNumber: 5,
      body: '结论',
      commentId: '77',
    });

    expect(result).toEqual({ action: 'patched', commentId: '77' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/issues/comments/77');
  });

  it('占位评论 404 时回退新建', async () => {
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.method === 'PATCH' ? jsonResponse(404, { message: 'Not Found' }) : jsonResponse(201, { id: 88 }),
    );
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await publishComment({
      api,
      repo: 'o/r',
      issueNumber: 5,
      body: '结论',
      commentId: '77',
    });

    expect(result).toEqual({ action: 'created', commentId: '88' });
    expect(calls.map((call) => call.method)).toEqual(['PATCH', 'POST']);
    expect(calls[1]?.url).toBe('https://api.github.com/repos/o/r/issues/5/comments');
    expect(calls[1]?.body).toEqual({ body: '结论' });
  });

  it('占位评论 410 时同样回退新建', async () => {
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.method === 'PATCH' ? jsonResponse(410, { message: 'Gone' }) : jsonResponse(201, { id: 89 }),
    );
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await publishComment({
      api,
      repo: 'o/r',
      issueNumber: 5,
      body: '结论',
      commentId: '77',
    });

    expect(result.action).toBe('created');
    expect(calls.map((call) => call.method)).toEqual(['PATCH', 'POST']);
  });

  it('其余非 2xx 直接抛出，不重复发评论', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(500, { message: 'boom' }));
    const api = new GitHubClient({ token: 't', fetchImpl });

    await expect(
      publishComment({ api, repo: 'o/r', issueNumber: 5, body: '结论', commentId: '77' }),
    ).rejects.toBeInstanceOf(GitHubApiError);
    expect(calls).toHaveLength(1);
  });

  it('正文命中敏感信息时阻断，且不发请求', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, {}));
    const api = new GitHubClient({ token: 't', fetchImpl });

    await expect(
      publishComment({
        api,
        repo: 'o/r',
        issueNumber: 5,
        body: 'token=sk-abcdefghijklmnop1234',
        commentId: '77',
      }),
    ).rejects.toBeInstanceOf(SecretScanBlockedError);
    expect(calls).toHaveLength(0);
  });
});

describe('isBotStopLabeled', () => {
  it('识别字符串与对象两种标签形态', () => {
    expect(isBotStopLabeled({ labels: ['bot:stop'] })).toBe(true);
    expect(isBotStopLabeled({ labels: [{ name: 'BOT:STOP' }] })).toBe(true);
    expect(isBotStopLabeled({ labels: ['bug', { name: 'crash' }] })).toBe(false);
    expect(isBotStopLabeled({})).toBe(false);
  });
});

describe('applyTriage', () => {
  it('补齐仓库已有标签，并摘掉 triage 触发标签', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'GET') {
        return jsonResponse(200, [
          { name: 'crash' },
          { name: 'scope: machine' },
          { name: 'needs triage' },
        ]);
      }
      if (call.method === 'POST') {
        return jsonResponse(200, []);
      }
      return emptyResponse(204);
    });
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await applyTriage({
      api,
      repo: 'o/r',
      issueNumber: 5,
      issue: { labels: ['needs triage'] },
      labels: ['crash', 'scope: machine', 'bug'],
      issueType: 'bug',
      triage: TRIAGE,
    });

    expect(result.kept).toEqual(['crash', 'scope: machine']);
    expect(result.added).toEqual(['crash', 'scope: machine']);
    expect(result.removed).toEqual(['needs triage']);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'DELETE']);
    expect(calls[2]?.url).toBe(
      'https://api.github.com/repos/o/r/issues/5/labels/needs%20triage',
    );
  });

  it('已被门禁全部丢弃时不发请求', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, []));
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await applyTriage({
      api,
      repo: 'o/r',
      issueNumber: 5,
      issue: { labels: [] },
      labels: ['bug'],
      issueType: 'bug',
      triage: TRIAGE,
    });

    expect(result.kept).toEqual([]);
    expect(result.added).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('仓库标签读取失败时只保留 issue 上已有的标签', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'GET') {
        return jsonResponse(403, { message: 'forbidden' });
      }
      return jsonResponse(200, []);
    });
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await applyTriage({
      api,
      repo: 'o/r',
      issueNumber: 5,
      issue: { labels: ['crash'] },
      labels: ['crash', 'scope: machine'],
      issueType: 'bug',
      triage: TRIAGE,
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('没有任何标签成立时不摘 triage 触发标签', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'GET') {
        return jsonResponse(200, [{ name: 'needs triage' }]);
      }
      return jsonResponse(200, []);
    });
    const api = new GitHubClient({ token: 't', fetchImpl });

    const result = await applyTriage({
      api,
      repo: 'o/r',
      issueNumber: 5,
      issue: { labels: ['needs triage'] },
      labels: ['crash'],
      issueType: 'bug',
      triage: TRIAGE,
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });
});
