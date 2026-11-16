/**
 * QQ 机器人运行配置。
 *
 * 配置来自一个显式传入的 JSON 文件（`main.ts` 只负责从 `QQBOT_CONFIG` 取路径），
 * 模块本身不读环境变量、不猜工作目录。校验失败一律抛 `ConfigError`，不回退默认值：
 * 一份写错了仓库绑定或 token 的配置，宁可起不来，也不要在群里做出越权动作。
 */
import { readFileSync } from 'node:fs';

import { ConfigError } from '@gt6ce/shared';
import { z } from 'zod';

/** 首版支持的命令名。新增命令时同步扩展这里、注册表与提示词。 */
export const COMMAND_NAMES = ['help', 'issue'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

const REPO_SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const REPO_SLUG_MESSAGE = '必须是 owner/name 形式';

/** RPC 端点只接受 http(s)：`new URL` 会放过任意 scheme，这里额外收紧。 */
const HttpUrl = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, '必须是 http(s) URL');

/**
 * 群 → 仓库绑定。
 *
 * `scope` 支持两种写法：
 * - `group:<group_openid>` / `c2c:<user_openid>`（推荐，语义明确）；
 * - 直接写 openid：按群处理，等价于 `group:<openid>`。
 */
export const BindingSchema = z
  .object({
    scope: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/^(?:group|c2c):\s*$/.test(value), 'scope 缺少 openid'),
    repo: z.string().trim().regex(REPO_SLUG_PATTERN, REPO_SLUG_MESSAGE),
    /** 允许执行写操作命令的成员 openid 列表；为空表示没有人可以写入。 */
    maintainers: z.array(z.string().trim().min(1)).default([]),
    /** 该群启用的命令；`/help` 始终可用。 */
    allowedCommands: z.array(z.enum(COMMAND_NAMES)).default([...COMMAND_NAMES]),
    /** 建 Issue 时是否附加 `<!-- bot:v1:stop -->`，避免被动分析再跑一遍。 */
    attachBotStop: z.boolean().default(false),
  })
  .strict();

export const QQBotConfigSchema = z
  .object({
    appId: z.string().trim().min(1),
    appSecret: z.string().trim().min(1),
    sandbox: z.boolean().default(false),
    /** 会话持久化目录；容器里挂在只读根文件系统之外的可写卷上。 */
    stateDir: z.string().trim().min(1).default('./state'),
    agentEndpoint: HttpUrl,
    agentToken: z.string().trim().min(1),
    githubWriterEndpoint: HttpUrl,
    githubWriterToken: z.string().trim().min(1),
    bindings: z.array(BindingSchema).default([]),
    /** 轮询分析任务的间隔与总超时。 */
    pollIntervalMs: z.number().int().positive().default(2_000),
    taskTimeoutMs: z.number().int().positive().default(180_000),
    /** 群会话（等待引用回复）的保留时长。 */
    sessionTtlMs: z.number().int().positive().default(30 * 60 * 1000),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.bindings.forEach((binding, index) => {
      const key = canonicalScope(binding.scope);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindings', index, 'scope'],
          message: `重复的 scope: ${key}`,
        });
      }
      seen.add(key);
    });
  });

export type Binding = z.infer<typeof BindingSchema>;
export type QQBotConfig = z.infer<typeof QQBotConfigSchema>;

/** 把配置里的 scope 规范化为 `group:<openid>` / `c2c:<openid>`。 */
export function canonicalScope(raw: string): string {
  const value = raw.trim();
  const separator = value.indexOf(':');
  if (separator > 0) {
    const prefix = value.slice(0, separator);
    const rest = value.slice(separator + 1).trim();
    if ((prefix === 'group' || prefix === 'c2c') && rest !== '') {
      return `${prefix}:${rest}`;
    }
  }
  return value === '' ? '' : `group:${value}`;
}

/** 校验并返回配置；`source` 只用于错误信息。 */
export function parseConfig(value: unknown, source = 'config'): QQBotConfig {
  const result = QQBotConfigSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
    throw new ConfigError(source, issues);
  }
  return result.data;
}

/** 从 JSON 文件加载配置。文件不可读或不是合法 JSON 都抛 `ConfigError`。 */
export function loadConfig(path: string): QQBotConfig {
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
  return parseConfig(parsed, path);
}

/** 建立 `scopeKey -> Binding` 索引；重复 scope 视为配置错误。 */
export function indexBindings(bindings: readonly Binding[]): ReadonlyMap<string, Binding> {
  const index = new Map<string, Binding>();
  for (const binding of bindings) {
    const key = canonicalScope(binding.scope);
    if (index.has(key)) {
      throw new ConfigError('bindings', [`重复的 scope: ${key}`]);
    }
    index.set(key, binding);
  }
  return index;
}
