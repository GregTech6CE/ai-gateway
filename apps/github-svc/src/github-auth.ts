/**
 * GitHub 认证。
 *
 * 两种模式：
 * - `token`：直接用配置提供的固定 token；
 * - `app`：用 App 私钥签 JWT，换取 installation token，并按过期时间缓存。
 *
 * 不引第三方 JWT 库：RS256 的签名只需要 `node:crypto` 的 `createSign`。
 */
import { createSign } from 'node:crypto';

import { ghRequest, type FetchLike } from '@gt6ce/github';

import type { GitHubAuthConfig } from './config.ts';

/** 认证失败；服务层把它映射成 502。 */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

export interface TokenProvider {
  tokenFor(repo: string): Promise<string>;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * 生成 GitHub App JWT。
 *
 * `iat` 回拨 60 秒容忍时钟漂移，`exp` 取 9 分钟以内（GitHub 上限 10 分钟）。
 */
export function createAppJwt(options: {
  readonly appId: string;
  readonly privateKey: string;
  readonly now?: number;
}): string {
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: options.appId }),
  );
  const data = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(data).sign(options.privateKey, 'base64url');
  return `${data}.${signature}`;
}

export class StaticTokenProvider implements TokenProvider {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** 固定 token 不区分仓库；参数只为满足 {@link TokenProvider} 的签名。 */
  async tokenFor(_repo: string): Promise<string> {
    return this.token;
  }
}

export interface AppTokenProviderOptions {
  readonly appId: string;
  readonly privateKey: string;
  /** 省略时按仓库查询 `/repos/{repo}/installation`。 */
  readonly installationId?: number;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  /** 毫秒时间戳。 */
  readonly expiresAt: number;
}

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 50 * 60 * 1000;

export class AppTokenProvider implements TokenProvider {
  private readonly options: AppTokenProviderOptions;

  private readonly tokens = new Map<number, CachedToken>();

  private readonly installations = new Map<string, number>();

  constructor(options: AppTokenProviderOptions) {
    this.options = options;
  }

  async tokenFor(repo: string): Promise<string> {
    const installationId = await this.resolveInstallation(repo);
    const now = this.now();
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
      return cached.token;
    }

    const jwt = createAppJwt({
      appId: this.options.appId,
      privateKey: this.options.privateKey,
      now,
    });
    const response = await ghRequest<{ token?: string; expires_at?: string }>(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      {
        token: jwt,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      },
    );
    if (!response.token) {
      throw new GitHubAuthError('GitHub 未返回 installation token');
    }
    const parsedExpiry = response.expires_at ? Date.parse(response.expires_at) : Number.NaN;
    this.tokens.set(installationId, {
      token: response.token,
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + DEFAULT_TOKEN_LIFETIME_MS,
    });
    return response.token;
  }

  private async resolveInstallation(repo: string): Promise<number> {
    if (this.options.installationId !== undefined) {
      return this.options.installationId;
    }
    const key = repo.toLowerCase();
    const cached = this.installations.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const jwt = createAppJwt({
      appId: this.options.appId,
      privateKey: this.options.privateKey,
      now: this.now(),
    });
    const response = await ghRequest<{ id?: number }>('GET', `/repos/${repo}/installation`, {
      token: jwt,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    if (typeof response.id !== 'number' || !Number.isInteger(response.id)) {
      throw new GitHubAuthError('无法解析 installation id');
    }
    this.installations.set(key, response.id);
    return response.id;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export function createTokenProvider(
  auth: GitHubAuthConfig,
  options: { fetchImpl?: FetchLike; baseUrl?: string; timeoutMs?: number; now?: () => number } = {},
): TokenProvider {
  if (auth.mode === 'token') {
    return new StaticTokenProvider(auth.token);
  }
  return new AppTokenProvider({
    appId: auth.appId,
    privateKey: auth.privateKey,
    ...(auth.installationId !== undefined ? { installationId: auth.installationId } : {}),
    ...options,
  });
}
