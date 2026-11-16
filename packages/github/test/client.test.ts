import { GitHubApiError } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import { GitHubClient, botLoginMatches, ghRequest, paginate } from '../src/client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ghRequest', () => {
  it('非 2xx 抛出带状态的 GitHubApiError', async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(403, { message: 'forbidden' });

    await expect(ghRequest('GET', '/repos/o/r', { fetchImpl })).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 403,
      method: 'GET',
      path: '/repos/o/r',
    });
  });

  it('空响应体解析为 undefined', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(null, { status: 204 });
    const result = await ghRequest<void>('DELETE', '/repos/o/r/labels/x', { fetchImpl });
    expect(result).toBeUndefined();
  });

  it('注入的 token 进入 Authorization 头', async () => {
    let authorization: string | null = null;
    const fetchImpl = async (_input: string, init?: RequestInit): Promise<Response> => {
      authorization = new Headers(init?.headers).get('authorization');
      return jsonResponse(200, { ok: true });
    };
    const api = new GitHubClient({ token: 'secret-token', fetchImpl });
    await api.request('GET', '/repos/o/r');
    expect(authorization).toBe('Bearer secret-token');
  });

  it('解析失败按协议错误处理', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('not-json', { status: 200 });
    await expect(ghRequest('GET', '/repos/o/r', { fetchImpl })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});

describe('paginate', () => {
  it('按页取到不足 100 条为止', async () => {
    const pages: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      pages.push(input);
      return input.endsWith('page=1')
        ? jsonResponse(200, Array.from({ length: 100 }, (_, index) => ({ id: index })))
        : jsonResponse(200, [{ id: 100 }]);
    };

    const items = await paginate<{ id: number }>('/repos/o/r/issues', { fetchImpl });

    expect(items).toHaveLength(101);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toBe('https://api.github.com/repos/o/r/issues?per_page=100&page=1');
    expect(pages[1]).toBe('https://api.github.com/repos/o/r/issues?per_page=100&page=2');
  });

  it('已有查询串时用 & 连接', async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      urls.push(input);
      return jsonResponse(200, []);
    };

    await paginate('/repos/o/r/issues?state=open', { fetchImpl });

    expect(urls[0]).toBe(
      'https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1',
    );
  });

  it('遵守 maxPages 上限', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return jsonResponse(200, Array.from({ length: 100 }, (_, index) => ({ id: index })));
    };

    await paginate('/repos/o/r/issues', { fetchImpl, maxPages: 2 });

    expect(calls).toBe(2);
  });
});

describe('botLoginMatches', () => {
  it('精确匹配与 Bot 前缀匹配都成立', () => {
    expect(botLoginMatches({ login: 'gt6ce-bot[bot]' }, 'gt6ce-bot[bot]')).toBe(true);
    expect(botLoginMatches({ login: 'gt6ce-bot', type: 'Bot' }, 'gt6ce-bot[bot]')).toBe(true);
  });

  it('身份不符时返回 false', () => {
    expect(botLoginMatches({ login: 'gt6ce-bot', type: 'User' }, 'gt6ce-bot[bot]')).toBe(false);
    expect(botLoginMatches({ login: 'other', type: 'Bot' }, 'gt6ce-bot[bot]')).toBe(false);
    expect(botLoginMatches(null, 'gt6ce-bot[bot]')).toBe(false);
  });
});
