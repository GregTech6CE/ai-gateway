/**
 * 分析服务配置。
 *
 * 配置来自显式传入的 JSON（`main.ts` 只负责从 `AGENT_SVC_CONFIG` 取路径）。凭据只有两种
 * 来源：配置里的 `value`，或 `file` 指向的只读挂载文件；两者必须二选一。任何缺失、非法或
 * 不可读都抛 `ConfigError`，服务不启动。
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { ConfigError, type ModelsConfig } from '@gt6ce/shared';
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

const ModelSchema = z
  .object({
    pool: z.string().min(1).default('shared'),
    role: z.string().min(1).default('analysis'),
    temperature: z.number().min(0).max(2).default(0.2),
    max_output_tokens: z.number().int().positive().default(4_000),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

const TasksSchema = z
  .object({
    concurrency: z.number().int().positive().default(2),
    ttl_ms: z.number().int().positive().default(60 * 60 * 1000),
    max_tasks: z.number().int().positive().default(200),
    timeout_ms: z.number().int().positive().default(180_000),
  })
  .strict();

const PathsSchema = z
  .object({
    /** 含 repos.json / models.json / budgets.json 的目录。 */
    config_dir: z.string().min(1),
    /** 含 common/draft.md 与 repos/<profile>/draft.md 的目录。 */
    prompts_dir: z.string().min(1),
  })
  .strict();

export const AgentSvcConfigSchema = z
  .object({
    server: ServerSchema.default({}),
    auth: z.object({ token: SecretRefSchema }).strict(),
    paths: PathsSchema,
    model: ModelSchema.default({}),
    tasks: TasksSchema.default({}),
  })
  .strict();

export interface AgentSvcConfig {
  readonly server: { readonly host: string; readonly port: number };
  readonly token: string;
  readonly configDir: string;
  readonly promptsDir: string;
  readonly model: {
    readonly pool: string;
    readonly role: string;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
  };
  readonly tasks: {
    readonly concurrency: number;
    readonly ttlMs: number;
    readonly maxTasks: number;
    readonly timeoutMs: number;
  };
}

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function readSecret(ref: { value?: string; file?: string }, baseDir: string, source: string): string {
  if (ref.value !== undefined) {
    return ref.value;
  }
  const path = resolveFrom(baseDir, ref.file ?? '');
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value === '') {
      throw new ConfigError(source, ['token 文件为空']);
    }
    return value;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(source, ['token 文件不可读']);
  }
}

/** 校验并解析配置；`baseDir` 用于解析相对路径。 */
export function parseAgentSvcConfig(
  value: unknown,
  baseDir: string,
  source = 'config',
): AgentSvcConfig {
  const result = AgentSvcConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(
      source,
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    );
  }
  const parsed = result.data;
  return {
    server: parsed.server,
    token: readSecret(parsed.auth.token, baseDir, source),
    configDir: resolveFrom(baseDir, parsed.paths.config_dir),
    promptsDir: resolveFrom(baseDir, parsed.paths.prompts_dir),
    model: {
      pool: parsed.model.pool,
      role: parsed.model.role,
      temperature: parsed.model.temperature,
      maxOutputTokens: parsed.model.max_output_tokens,
      timeoutMs: parsed.model.timeout_ms,
    },
    tasks: {
      concurrency: parsed.tasks.concurrency,
      ttlMs: parsed.tasks.ttl_ms,
      maxTasks: parsed.tasks.max_tasks,
      timeoutMs: parsed.tasks.timeout_ms,
    },
  };
}

/** 从文件加载配置。 */
export function loadAgentSvcConfig(path: string): AgentSvcConfig {
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
  return parseAgentSvcConfig(parsed, dirname(path), path);
}

/**
 * 启动前的模型可用性检查。
 *
 * 至少要有 1 个启用的 endpoint 能在环境里取到 key；否则服务起来也只能把所有任务标失败，
 * 不如直接拒绝启动，让编排层把问题暴露在 healthcheck 上。
 */
export function assertModelAvailable(
  models: ModelsConfig,
  poolName: string,
  role: string,
  env: NodeJS.ProcessEnv,
): void {
  const pool = models.pools[poolName];
  if (!pool) {
    throw new ConfigError('config/models.json', [`未声明的模型池: ${poolName}`]);
  }
  const bound = pool.roles[role] ?? [];
  if (bound.length === 0) {
    throw new ConfigError('config/models.json', [`模型池 ${poolName} 没有绑定角色 ${role}`]);
  }
  const endpoints = new Map(pool.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const usable = bound.some((binding) => {
    const endpoint = endpoints.get(binding.endpoint);
    return (
      endpoint !== undefined &&
      endpoint.enabled &&
      (env[endpoint.api_key_env] ?? '').trim() !== ''
    );
  });
  if (!usable) {
    throw new ConfigError('env', ['没有可用的模型 key：请检查 MODEL_KEY_* 注入']);
  }
}
