import { createVerify, generateKeyPairSync } from 'node:crypto';

import type { FetchLike } from '@gt6ce/github';
import { describe, expect, it } from 'vitest';

import {
  AppTokenProvider,
  GitHubAuthError,
  StaticTokenProvider,
  createAppJwt,
} from '../src/github-auth.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createAppJwt', () => {
  it('生成可验证的 RS256 JWT，claims 符合 GitHub 要求', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const jwt = createAppJwt({ appId: '12345', privateKey: PRIVATE_PEM, now });
    const [header, payload, signature] = jwt.split('.');
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    const decodedHeader = JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'));
    expect(decodedHeader).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp).toBe(claims.iat + 540);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true);
  });
});

describe('StaticTokenProvider', () => {
  it('始终返回配置的 token', async () => {
    const provider = new StaticTokenProvider('ghp_x');
    await expect(provider.tokenFor('o/r')).resolves.toBe('ghp_x');
  });
});

describe('AppTokenProvider', () => {
  it('解析 installation 并缓存 token，过期后刷新', async () => {
    let now = Date.UTC(2026, 0, 1);
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/repos/o/r/installation')) {
        return json(200, { id: 7 });
      }
      if (url.endsWith('/app/installations/7/access_tokens')) {
        return json(200, {
          token: `tok-${calls.length}`,
          expires_at: new Date(now + 3_600_000).toISOString(),
        });
      }
      return json(404, { message: 'not found' });
    };
    const provider = new AppTokenProvider({
      appId: '12345',
      privateKey: PRIVATE_PEM,
      fetchImpl,
      baseUrl: 'https://api.test',
      now: () => now,
    });

    await expect(provider.tokenFor('o/r')).resolves.toBe('tok-2');
    expect(calls).toHaveLength(2);

    // 缓存命中，不再发请求。
    await expect(provider.tokenFor('o/r')).resolves.toBe('tok-2');
    expect(calls).toHaveLength(2);

    // 超过过期时间后重新签发。
    now += 3_600_000;
    await expect(provider.tokenFor('o/r')).resolves.toBe('tok-3');
    expect(calls).toHaveLength(3);
  });

  it('配置 installation id 时跳过查询', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return json(200, { token: 'tok', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    };
    const provider = new AppTokenProvider({
      appId: '1',
      privateKey: PRIVATE_PEM,
      installationId: 42,
      fetchImpl,
      baseUrl: 'https://api.test',
    });

    await expect(provider.tokenFor('o/r')).resolves.toBe('tok');
    expect(calls).toEqual(['POST https://api.test/app/installations/42/access_tokens']);
  });

  it('GitHub 未返回 token 时抛 GitHubAuthError', async () => {
    const fetchImpl: FetchLike = async () => json(200, {});
    const provider = new AppTokenProvider({
      appId: '1',
      privateKey: PRIVATE_PEM,
      installationId: 42,
      fetchImpl,
      baseUrl: 'https://api.test',
    });

    await expect(provider.tokenFor('o/r')).rejects.toBeInstanceOf(GitHubAuthError);
  });
});
