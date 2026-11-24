/**
 * 配置契约：仓库白名单、模型池与运行预算。
 *
 * 只做校验与加载，不在模块顶层读取环境变量、也不产生文件或网络副作用；
 * 配置目录由调用方显式传入，避免库去猜工作目录。
 *
 * 与 v1 相比整体移除了速率与费率配额：`per_issue_per_hour`、`per_repo_per_day`、
 * `global_per_day` 以及 `max_turns`、`max_tokens`。触发控制改由 `bot:v1:` 标记与
 * `max_issue_age_days` 承担；模型池只保留 429/5xx 的故障冷却参数。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ConfigError } from './errors.ts';

/** 六轴标签模型的轴名，顺序即渲染与上限的既定顺序。 */
export const LABEL_AXES = ['type', 'kind', 'scope', 'status', 'priority', 'version'] as const;
export type LabelAxis = (typeof LABEL_AXES)[number];

/** Issue 创建超过该天数后不再被动触发；用户主动强制触发不受此限。 */
export const DEFAULT_MAX_ISSUE_AGE_DAYS = 7;

const REPO_SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const REPO_SLUG_MESSAGE = '必须是 owner/name 形式';

/** 全局 bot 身份：仓库项可覆盖 login 与 mention。 */
export const BotIdentitySchema = z
  .object({
    login: z.string().min(1),
    mention: z.string().min(1),
  })
  .strict();

export const GoldenRefSchema = z
  .object({
    repo: z.string().regex(REPO_SLUG_PATTERN, REPO_SLUG_MESSAGE),
    commit: z.string().min(7),
  })
  .strict();

export const RejectConfigSchema = z
  .object({
    only: z.array(z.string().min(1)).default([]),
    min_confidence: z.number().min(0).max(1).default(0.9),
  })
  .strict();

export const LabelAxesSchema = z
  .object({
    type: z.array(z.string().min(1)).optional(),
    kind: z.array(z.string().min(1)).optional(),
    scope: z.array(z.string().min(1)).optional(),
    status: z.array(z.string().min(1)).optional(),
    priority: z.array(z.string().min(1)).optional(),
    version: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const LabelLimitsSchema = z
  .object({
    type: z.number().int().min(0),
    kind: z.number().int().min(0),
    scope: z.number().int().min(0),
    status: z.number().int().min(0),
    priority: z.number().int().min(0),
    version: z.number().int().min(0),
  })
  .partial()
  .strict();

export const TriageConfigSchema = z
  .object({
    /** 进入代码分析所需标签组合：任一子数组全部命中即可。 */
    process_only: z.array(z.array(z.string().min(1)).min(1)).default([]),
    /** 模型输出标签的白名单，也是没有六轴配置时的回退集合。 */
    write_only: z.array(z.string().min(1)).default([]),
    label_axes: LabelAxesSchema.default({}),
    label_limits: LabelLimitsSchema.default({}),
    triage_labels: z.array(z.string().min(1)).default([]),
    remove_after_triage: z.boolean().default(true),
  })
  .strict();

export const RepoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    bot_login: z.string().min(1).optional(),
    bot_mention: z.string().min(1).optional(),
    code_repo: z.string().regex(REPO_SLUG_PATTERN, REPO_SLUG_MESSAGE),
    code_ref_mode: z.enum(['tag', 'branch', 'commit']).default('tag'),
    tag_template: z.string().min(1).default('v{version}'),
    fallback_ref: z.string().min(1).default('master'),
    golden: GoldenRefSchema.optional(),
    reject: RejectConfigSchema.default({}),
    model_pool: z.string().min(1).default('shared'),
    prompt_profile: z.string().min(1).optional(),
    extra_code_refs: z.array(z.string().min(1)).default([]),
    auxiliary_materials: z.array(z.string().min(1)).default([]),
    triage: TriageConfigSchema.default({}),
  })
  .strict();

/**
 * `repos.json` 的完整契约。
 *
 * 仓库键要求小写 `owner/name`：查找一律按小写归一，键本身再要求小写，
 * 才能保证「配置里写了但大小写不一致」不会变成静默不命中。
 */
export const ReposConfigSchema = z
  .object({
    bot: BotIdentitySchema,
    repos: z.record(z.string(), RepoConfigSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const key of Object.keys(config.repos)) {
      if (!REPO_SLUG_PATTERN.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repos', key],
          message: `仓库键${REPO_SLUG_MESSAGE}`,
        });
      } else if (key !== key.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repos', key],
          message: '仓库键必须小写',
        });
      }
    }
  });

export type BotIdentity = z.infer<typeof BotIdentitySchema>;
export type RejectConfig = z.infer<typeof RejectConfigSchema>;
export type LabelAxes = z.infer<typeof LabelAxesSchema>;
export type LabelLimits = z.infer<typeof LabelLimitsSchema>;
export type TriageConfig = z.infer<typeof TriageConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type ReposConfig = z.infer<typeof ReposConfigSchema>;

/**
 * ACP 驱动配置：如何拉起一个 ACP agent 进程。
 *
 * `command` 必须能在 `PATH` 中解析；`api_key_target_env` 指定把模型 key 注入子进程的
 * 哪个环境变量，留空表示不注入（agent 自行处理鉴权）。`preset` 承载程序专属的目录与
 * 配置准备，通用 ACP 接入保持 `generic`。
 */
export const AcpModelConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    api_key_target_env: z.string().min(1).optional(),
    preset: z.enum(['generic', 'mistral-vibe']).default('generic'),
  })
  .strict();

export const ModelEndpointSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    /**
     * 出口协议：OpenAI 兼容 HTTP，或通过子进程讲 ACP。
     *
     * ACP 不走 `base_url`，也不支持 `response_format`；入口是否可用由命令能否解析与
     * 握手结果决定。
     */
    driver: z.enum(['openai-compatible', 'acp']).default('openai-compatible'),
    base_url: z.string().url().optional(),
    api_key_env: z.string().min(1),
    model: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    /**
     * 该入口是否支持 JSON Schema 形式的 `response_format`。
     *
     * 默认 `true`：绝大多数 OpenAI 兼容网关都支持。不支持时必须显式关掉，否则 provider
     * 只会发一条 `unsupported responseFormat` 警告、schema 静默失效，模型按自由文本作答，
     * 最终由 SDK 抛 `NoObjectGeneratedError`——看起来像网络故障，实际是配置问题。
     */
    structured_outputs: z.boolean().default(true),
    acp: AcpModelConfigSchema.optional(),
  })
  .strict()
  .superRefine((endpoint, ctx) => {
    if (endpoint.driver === 'acp') {
      if (!endpoint.acp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acp'],
          message: 'driver 为 acp 时必须配置 acp 段',
        });
      }
      return;
    }
    if (!endpoint.base_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base_url'],
        message: 'driver 为 openai-compatible 时 base_url 必填',
      });
    }
    if (endpoint.acp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acp'],
        message: 'acp 段仅在 driver 为 acp 时允许',
      });
    }
  });

export const ModelBindingSchema = z
  .object({
    endpoint: z.string().min(1),
    context: z.number().int().positive().optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    weight: z.number().int().min(0).default(1),
  })
  .strict();

/**
 * 一个模型池：endpoint 是健康单位，role 只是绑定。
 *
 * 校验在结构之外还要求 endpoint id 唯一、绑定指向已声明的 endpoint——
 * 悬空绑定会让故障切换到一半才发现没有可用入口。
 */
export const ModelPoolSchema = z
  .object({
    endpoints: z.array(ModelEndpointSchema).min(1),
    roles: z.record(z.string(), z.array(ModelBindingSchema)).default({}),
  })
  .strict()
  .superRefine((pool, ctx) => {
    const ids = new Set<string>();
    pool.endpoints.forEach((endpoint, index) => {
      if (ids.has(endpoint.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', index, 'id'],
          message: `重复的 endpoint id: ${endpoint.id}`,
        });
      }
      ids.add(endpoint.id);
    });
    for (const [role, bindings] of Object.entries(pool.roles)) {
      bindings.forEach((binding, index) => {
        if (!ids.has(binding.endpoint)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['roles', role, index, 'endpoint'],
            message: `未声明的 endpoint: ${binding.endpoint}`,
          });
        }
      });
    }
  });

export const ModelsConfigSchema = z
  .object({
    pools: z.record(z.string(), ModelPoolSchema),
  })
  .strict();

export type AcpModelConfig = z.infer<typeof AcpModelConfigSchema>;
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;
export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export type ModelPool = z.infer<typeof ModelPoolSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/**
 * 单次相关性分类的请求预算。
 *
 * `max_output_tokens` 是请求参数（模型一次最多写多少），不是账本式配额，
 * 因此保留；历史上的 `l2.max_tokens` / `l2.max_turns` 属于配额，已移除。
 */
export const RelevanceBudgetSchema = z
  .object({
    timeout_seconds: z.number().int().positive().default(90),
    max_output_tokens: z.number().int().positive().default(400),
  })
  .strict();

/** L2 分析的预算：墙钟上限 + 绕圈检测阈值（不再有 token 配额与固定轮次上限）。 */
export const L2BudgetSchema = z
  .object({
    timeout_minutes: z.number().int().positive().default(60),
    /**
     * 连续多少步出现完全相同的工具调用（工具名 + 参数）即判定为绕圈。
     *
     * 触发后不再给工具，由模型基于已有证据收尾。默认 3：一步重复通常只是重试，
     * 连续三次完全相同基本可以确定在原地打转。
     */
    loop_repeat_threshold: z.number().int().min(2).default(3),
  })
  .strict();

export const ArtifactBudgetSchema = z
  .object({
    retention_days: z.number().int().positive(),
    max_attachment_bytes: z.number().int().positive(),
    max_total_attachment_bytes: z.number().int().positive(),
  })
  .strict();

/** 模型池故障冷却：只描述遇 429/5xx 时如何退避，不描述额度。 */
export const ModelPoolBudgetSchema = z
  .object({
    early_base_minutes: z.number().min(0),
    early_max_minutes: z.number().min(0),
    late_base_minutes: z.number().min(0),
    late_max_minutes: z.number().min(0),
    rate_limit_retries: z.number().int().min(0),
    rate_limit_wait_seconds: z.number().min(0),
    rate_limit_min_wait_seconds: z.number().min(0),
    rate_limit_max_wait_seconds: z.number().min(0),
  })
  .strict();

export const BudgetDefaultsSchema = z
  .object({
    max_issue_age_days: z.number().int().positive().default(DEFAULT_MAX_ISSUE_AGE_DAYS),
    /** 占位评论视为「仍在处理中」的窗口，与 `bot:v1:pending` 的过期判定同源。 */
    requested_stale_minutes: z.number().int().positive().default(70),
    relevance: RelevanceBudgetSchema,
    l2: L2BudgetSchema,
    artifacts: ArtifactBudgetSchema,
    model_pool: ModelPoolBudgetSchema,
  })
  .strict();

export const BudgetsConfigSchema = z
  .object({
    defaults: BudgetDefaultsSchema,
  })
  .strict();

export type RelevanceBudget = z.infer<typeof RelevanceBudgetSchema>;
export type L2Budget = z.infer<typeof L2BudgetSchema>;
export type ArtifactBudget = z.infer<typeof ArtifactBudgetSchema>;
export type ModelPoolBudget = z.infer<typeof ModelPoolBudgetSchema>;
export type BudgetDefaults = z.infer<typeof BudgetDefaultsSchema>;
export type BudgetsConfig = z.infer<typeof BudgetsConfigSchema>;

/** 把 Zod 的校验问题压成可读字符串，便于写进 `ConfigError.issues`。 */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取 JSON 文件；不可读或不可解析都转成 `ConfigError`。 */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(path, [`无法读取: ${describeError(error)}`]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(path, [`JSON 解析失败: ${describeError(error)}`]);
  }
}

export function parseReposConfig(raw: unknown): ReposConfig {
  const result = ReposConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError('config/repos.json', formatZodIssues(result.error));
  }
  return result.data;
}

export function parseModelsConfig(raw: unknown): ModelsConfig {
  const result = ModelsConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError('config/models.json', formatZodIssues(result.error));
  }
  return result.data;
}

export function parseBudgetsConfig(raw: unknown): BudgetsConfig {
  const result = BudgetsConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError('config/budgets.json', formatZodIssues(result.error));
  }
  return result.data;
}

export function loadReposConfig(configDir: string): ReposConfig {
  return parseReposConfig(readJsonFile(join(configDir, 'repos.json')));
}

export function loadModelsConfig(configDir: string): ModelsConfig {
  return parseModelsConfig(readJsonFile(join(configDir, 'models.json')));
}

export function loadBudgetsConfig(configDir: string): BudgetsConfig {
  return parseBudgetsConfig(readJsonFile(join(configDir, 'budgets.json')));
}

export interface ConfigBundle {
  readonly repos: ReposConfig;
  readonly models: ModelsConfig;
  readonly budgets: BudgetsConfig;
}

/** 一次加载三份配置，任一非法即抛出，不返回半成品。 */
export function loadConfigs(configDir: string): ConfigBundle {
  return {
    repos: loadReposConfig(configDir),
    models: loadModelsConfig(configDir),
    budgets: loadBudgetsConfig(configDir),
  };
}

/** 解析后的仓库配置：补上归一化键与合并后的 bot 身份。 */
export type ResolvedRepoConfig = Omit<RepoConfig, 'bot_login' | 'bot_mention'> & {
  readonly key: string;
  readonly botLogin: string;
  readonly botMention: string;
};

/**
 * 按 `owner/name` 取仓库配置；未登记即抛错，不退化为默认放行。
 *
 * 全局 `bot` 提供默认身份，仓库项可覆盖。
 */
export function resolveRepoConfig(config: ReposConfig, repo: string): ResolvedRepoConfig {
  const key = repo.trim().toLowerCase();
  const entry = config.repos[key];
  if (!entry) {
    throw new ConfigError('config/repos.json', [`未登记的仓库: ${repo}`]);
  }
  const { bot_login, bot_mention, ...rest } = entry;
  return {
    ...rest,
    key,
    botLogin: bot_login ?? config.bot.login,
    botMention: bot_mention ?? config.bot.mention,
  };
}

/** 预算按 `budgets.json` 的 `defaults` 取用。 */
export function budgetDefaults(budgets: BudgetsConfig): BudgetDefaults {
  return budgets.defaults;
}
