import { describe, expect, it } from 'vitest';

import {
  AgentRpcClient,
  GitHubWriterRpcClient,
  RpcError,
  RpcTaskError,
  type FetchLike,
} from '../src/rpc-clients.ts';

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Recorded {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

function recordingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal,
    });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const REQUEST = {
  kind: 'issue-draft' as const,
  repo: 'gregtech6ce/gregtech6',
  scope: 'group:g-1',
  requester: 'u1',
  draft: {
    title: '崩溃',
    version: '1.21.1',
    steps: '打开合成器',
    expected: '正常显示',
  },
};

describe('AgentRpcClient', () => {
  it('提交任务时带 Bearer token，并把 202 的 taskId 取出来', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(202, { taskId: 'task-9' }));
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080/', token: 'tok', fetchImpl });

    const accepted = await client.submit(REQUEST);

    expect(accepted.taskId).toBe('task-9');
    expect(calls[0]?.url).toBe('http://agent:8080/tasks');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(calls[0]?.body).toEqual(REQUEST);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('查询任务状态使用 URL 编码的 taskId', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { id: 'a/b', status: 'running' }),
    );
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });

    const snapshot = await client.status('a/b');

    expect(snapshot.status).toBe('running');
    expect(calls[0]?.url).toBe('http://agent:8080/tasks/a%2Fb');
  });

  it('轮询到 succeeded 后返回草稿', async () => {
    const responses = [
      jsonResponse(200, { id: 't-1', status: 'queued' }),
      jsonResponse(200, { id: 't-1', status: 'running' }),
      jsonResponse(200, {
        id: 't-1',
        status: 'succeeded',
        result: { title: '崩溃', body: '正文', labels: ['bug'] },
      }),
    ];
    const { fetchImpl } = recordingFetch(() => responses.shift() ?? jsonResponse(500, {}));
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });

    const draft = await client.wait('t-1', {
      intervalMs: 1,
      timeoutMs: 1_000,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(draft).toEqual({ title: '崩溃', body: '正文', labels: ['bug'] });
  });

  it('任务失败时抛 RpcTaskError，并保留后端原因', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { id: 't-2', status: 'failed', error: 'model exploded' }),
    );
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });

    await expect(
      client.wait('t-2', { intervalMs: 1, timeoutMs: 1_000, sleep: async () => undefined }),
    ).rejects.toThrowError(new RpcTaskError('t-2', 'model exploded'));
  });

  it('轮询超时抛 RpcTaskError', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { id: 't-3', status: 'running' }),
    );
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });
    let now = 0;

    await expect(
      client.wait('t-3', {
        intervalMs: 1,
        timeoutMs: 500,
        sleep: async () => undefined,
        now: () => {
          now += 600;
          return now;
        },
      }),
    ).rejects.toThrowError(/超时/);
  });

  it('非 2xx 抛 RpcError，保留状态码与响应片段', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('bad token', { status: 401 }));
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });

    const failure = client.submit(REQUEST);
    await expect(failure).rejects.toBeInstanceOf(RpcError);
    await expect(failure).rejects.toMatchObject({ status: 401, path: '/tasks', detail: 'bad token' });
  });

  it('响应不符合契约时抛 RpcError', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(202, { id: 'wrong' }));
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });

    await expect(client.submit(REQUEST)).rejects.toThrowError(/响应不符合契约/);
  });

  it('网络失败包装为 status=0 的 RpcError', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = new AgentRpcClient({ endpoint: 'http://agent:8080', token: 'tok', fetchImpl });

    await expect(client.submit(REQUEST)).rejects.toMatchObject({
      status: 0,
      detail: '请求失败: ECONNREFUSED',
    });
  });
});

describe('GitHubWriterRpcClient', () => {
  it('创建 Issue 时提交结构化请求并解析编号与链接', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(201, { number: 7, url: 'https://github.com/o/r/issues/7' }),
    );
    const client = new GitHubWriterRpcClient({
      endpoint: 'http://writer:8080',
      token: 'writer-token',
      fetchImpl,
    });

    const issue = await client.createIssue({
      requestId: 'session-1',
      repo: 'o/r',
      title: '崩溃',
      body: '正文',
      labels: ['bug'],
    });

    expect(issue).toEqual({ number: 7, url: 'https://github.com/o/r/issues/7' });
    expect(calls[0]?.url).toBe('http://writer:8080/issues');
    expect(calls[0]?.headers.authorization).toBe('Bearer writer-token');
    expect(calls[0]?.body).toMatchObject({ requestId: 'session-1', repo: 'o/r' });
  });

  it('返回非法链接时按契约错误处理', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(201, { number: 7, url: 'not-a-url' }));
    const client = new GitHubWriterRpcClient({
      endpoint: 'http://writer:8080',
      token: 'writer-token',
      fetchImpl,
    });

    await expect(
      client.createIssue({ requestId: 's', repo: 'o/r', title: 't', body: 'b', labels: [] }),
    ).rejects.toThrowError(/响应不符合契约/);
  });
});
