import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  HttpError,
  bearerToken,
  methodNotAllowed,
  readJsonBody,
  requestUrl,
  tokensMatch,
  writeError,
  writeJson,
} from '../src/http.ts';

function asRequest(chunks: readonly (string | Buffer)[]): IncomingMessage {
  return Readable.from(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))) as unknown as IncomingMessage;
}

interface FakeResponse {
  readonly response: ServerResponse;
  readonly headers: Map<string, string | number>;
  body(): string;
}

function fakeResponse(): FakeResponse {
  const headers = new Map<string, string | number>();
  let body = '';
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string | number) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      body += chunk ?? '';
    },
  };
  return {
    response: response as unknown as ServerResponse,
    headers,
    body: () => body,
  };
}

describe('tokensMatch', () => {
  it('相同 token 返回 true，不同或缺失返回 false', () => {
    expect(tokensMatch('secret-token', 'secret-token')).toBe(true);
    expect(tokensMatch('secret-token', 'secret-tokeN')).toBe(false);
    expect(tokensMatch(undefined, 'secret-token')).toBe(false);
    expect(tokensMatch('', 'secret-token')).toBe(false);
    expect(tokensMatch('secret-token', '')).toBe(false);
  });

  it('长度不同也走常量时间路径且不抛错', () => {
    expect(tokensMatch('short', 'a-much-longer-token')).toBe(false);
    expect(tokensMatch('a-much-longer-token', 'short')).toBe(false);
  });

  it('非 ASCII token 也能比较', () => {
    expect(tokensMatch('令牌-一', '令牌-一')).toBe(true);
    expect(tokensMatch('令牌-一', '令牌-二')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('解析标准 Bearer 头，大小写不敏感', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc  ')).toBe('abc');
    expect(bearerToken(['Bearer abc', 'Bearer def'])).toBe('abc');
  });

  it('缺失或格式不符返回 undefined', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken('Bearer   ')).toBeUndefined();
  });
});

describe('readJsonBody', () => {
  it('解析合法 JSON', async () => {
    await expect(readJsonBody(asRequest(['{"a":1,', '"b":[2]}']))).resolves.toEqual({
      a: 1,
      b: [2],
    });
  });

  it('空体与非法 JSON 都是 400', async () => {
    await expect(readJsonBody(asRequest(['   ']))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_body',
    });
    await expect(readJsonBody(asRequest(['{oops']))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_body',
    });
  });

  it('超过字节上限返回 413', async () => {
    const chunk = Buffer.alloc(600 * 1024, 0x61);
    await expect(
      readJsonBody(asRequest([chunk, chunk]), { maxBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      readJsonBody(asRequest([chunk, chunk]), { maxBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  });
});

describe('writeJson / writeError / methodNotAllowed', () => {
  it('写 JSON 响应并设置头部', () => {
    const fake = fakeResponse();
    writeJson(fake.response, 201, { ok: true });

    expect(fake.response.statusCode).toBe(201);
    expect(fake.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(fake.headers.get('cache-control')).toBe('no-store');
    expect(fake.body()).toBe('{"ok":true}\n');
  });

  it('错误响应带稳定错误码', () => {
    const fake = fakeResponse();
    writeError(fake.response, 403, '仓库未授权', 'repo_forbidden');

    expect(fake.response.statusCode).toBe(403);
    expect(JSON.parse(fake.body())).toEqual({ error: '仓库未授权', code: 'repo_forbidden' });
  });

  it('405 附带 Allow 头', () => {
    const fake = fakeResponse();
    methodNotAllowed(fake.response, ['GET', 'POST']);

    expect(fake.response.statusCode).toBe(405);
    expect(fake.headers.get('allow')).toBe('GET, POST');
  });
});

describe('requestUrl', () => {
  it('相对路径补上占位 origin', () => {
    const request = { url: '/tasks/abc?x=1' } as IncomingMessage;
    const url = requestUrl(request);
    expect(url.pathname).toBe('/tasks/abc');
    expect(url.searchParams.get('x')).toBe('1');
  });
});
