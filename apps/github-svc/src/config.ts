/**
 * 写回服务配置。
 *
 * GitHub 凭据二选一：固定 token，或 App 凭据（app id + 私钥文件，可选 installation id）。
 * 文件路径都相对配置文件解析，便于容器只读挂载。任何缺失或非法都抛 `ConfigError`。
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { ConfigError } from '@gt6ce/shared';
import { z } from 'zod';

const SecretRefSchema = z
  .object({
    value: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (ref) => (ref.value === undefined) !== (ref.file === undefined),
    'value 与 file 必须且只能提供一个',
  );

const ServerSchema = z
  .object({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(8080),
  })
  .strict();

const IssuesSchema = z
  .object({
    /** 幂等缓存保留时长；QQ 侧重试窗口远小于此值。 */
    ttl_ms: z.number().int().positive().default(24 * 60 * 60 * 1000),
    max_entries: z.number().int().positive().default(1_000),
    /** 单次 GitHub 请求超时。 */
    timeout_ms: z.number().int().positive().default(15_000),
  })
  .strict();

const GitHubSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('token'),
      token: SecretRefSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('app'),
      app_id: z.string().min(1),
      private_key_file: z.string().min(1),
      installation_id: z.number().int().positive().optional(),
    })
    .strict(),
]);

export const GitHubSvcConfigSchema = z
  .object({
    server: ServerSchema.default({}),
    auth: z.object({ token: SecretRefSchema }).strict(),
    paths: z.object({ config_dir: z.string().min(1) }).strict(),
    github: GitHubSchema,
    issues: IssuesSchema.default({}),
  })
  .strict();

export type GitHubAuthConfig =
  | { readonly mode: 'token'; readonly token: string }
  | {
      readonly mode: 'app';
      readonly appId: string;
      readonly privateKey: string;
      readonly installationId?: number;
    };

export interface GitHubSvcConfig {
  readonly server: { readonly host: string; readonly port: number };
  readonly token: string;
  readonly configDir: string;
  readonly github: GitHubAuthConfig;
  readonly issues: {
    readonly ttlMs: number;
    readonly maxEntries: number;
    readonly timeoutMs: number;
  };
}

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function readSecret(
  ref: { value?: string; file?: string },
  baseDir: string,
  source: string,
  label: string,
): string {
  if (ref.value !== undefined) {
    return ref.value;
  }
  const path = resolveFrom(baseDir, ref.file ?? '');
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value === '') {
      throw new ConfigError(source, [`${label} 文件为空`]);
    }
    return value;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(source, [`${label} 文件不可读`]);
  }
}

function readPrivateKey(path: string, baseDir: string, source: string): string {
  const resolved = resolveFrom(baseDir, path);
  try {
    const value = readFileSync(resolved, 'utf8');
    if (!value.includes('BEGIN') || !value.includes('PRIVATE KEY')) {
      throw new ConfigError(source, ['App 私钥不是 PEM 格式']);
    }
    return value;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(source, ['App 私钥文件不可读']);
  }
}

export function parseGitHubSvcConfig(
  value: unknown,
  baseDir: string,
  source = 'config',
): GitHubSvcConfig {
  const result = GitHubSvcConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(
      source,
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    );
  }
  const parsed = result.data;
  const github: GitHubAuthConfig =
    parsed.github.mode === 'token'
      ? {
          mode: 'token',
          token: readSecret(parsed.github.token, baseDir, source, 'GitHub token'),
        }
      : {
          mode: 'app',
          appId: parsed.github.app_id,
          privateKey: readPrivateKey(parsed.github.private_key_file, baseDir, source),
          ...(parsed.github.installation_id !== undefined
            ? { installationId: parsed.github.installation_id }
            : {}),
        };
  return {
    server: parsed.server,
    token: readSecret(parsed.auth.token, baseDir, source, '服务 token'),
    configDir: resolveFrom(baseDir, parsed.paths.config_dir),
    github,
    issues: {
      ttlMs: parsed.issues.ttl_ms,
      maxEntries: parsed.issues.max_entries,
      timeoutMs: parsed.issues.timeout_ms,
    },
  };
}

export function loadGitHubSvcConfig(path: string): GitHubSvcConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(path, ['配置文件不可读']);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(path, ['不是合法的 JSON']);
  }
  return parseGitHubSvcConfig(parsed, dirname(path), path);
}
