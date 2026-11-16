import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_MAX_ISSUE_AGE_DAYS,
  budgetDefaults,
  loadConfigs,
  parseBudgetsConfig,
  parseReposConfig,
  resolveRepoConfig,
} from '../src/index.ts';

const CONFIG_DIR = fileURLToPath(new URL('../../../config', import.meta.url));

const MINIMAL_BUDGETS = {
  defaults: {
    relevance: { timeout_seconds: 90, max_output_tokens: 400 },
    l2: { timeout_minutes: 60, loop_repeat_threshold: 3, stall_seconds: 180 },
    artifacts: { retention_days: 30, max_attachment_bytes: 1, max_total_attachment_bytes: 2 },
    model_pool: {
      early_base_minutes: 15,
      early_max_minutes: 1440,
      late_base_minutes: 5,
      late_max_minutes: 360,
      rate_limit_retries: 5,
      rate_limit_wait_seconds: 60,
      rate_limit_min_wait_seconds: 5,
      rate_limit_max_wait_seconds: 300,
    },
  },
};

describe('真实配置', () => {
  it('三份配置全部通过校验', () => {
    const config = loadConfigs(CONFIG_DIR);
    expect(Object.keys(config.repos.repos)).toContain('gregtech6ce/gregtech6');
    expect(Object.keys(config.models.pools)).toContain('shared');
    expect(config.budgets.defaults.max_issue_age_days).toBe(DEFAULT_MAX_ISSUE_AGE_DAYS);
  });

  it('速率与费率配额字段已从预算中移除', () => {
    const budgets = loadConfigs(CONFIG_DIR).budgets;
    expect(Object.hasOwn(budgets.defaults, 'per_issue_per_hour')).toBe(false);
    expect(Object.hasOwn(budgets.defaults, 'per_repo_per_day')).toBe(false);
    expect(Object.hasOwn(budgets.defaults, 'global_per_day')).toBe(false);
    expect(Object.hasOwn(budgets.defaults.l2, 'max_turns')).toBe(false);
    expect(Object.hasOwn(budgets.defaults.l2, 'max_tokens')).toBe(false);
  });

  it('保留模型池 429/5xx 冷却参数', () => {
    const budgets = loadConfigs(CONFIG_DIR).budgets;
    expect(budgets.defaults.model_pool.early_base_minutes).toBeGreaterThan(0);
    expect(budgets.defaults.model_pool.late_max_minutes).toBeGreaterThan(0);
  });
});

describe('resolveRepoConfig', () => {
  it('合并全局 bot 身份并归一化键', () => {
    const config = loadConfigs(CONFIG_DIR).repos;
    const repo = resolveRepoConfig(config, ' GregTech6CE/GregTech6 ');
    expect(repo.key).toBe('gregtech6ce/gregtech6');
    expect(repo.botLogin).toBe('gt6ce-bot[bot]');
    expect(repo.botMention).toBe('@gt6ce-bot');
  });

  it('未登记的仓库直接抛错，不退化放行', () => {
    const config = loadConfigs(CONFIG_DIR).repos;
    expect(() => resolveRepoConfig(config, 'other/repo')).toThrow(ConfigError);
  });
});

describe('parseReposConfig', () => {
  const bot = { login: 'bot[bot]', mention: '@bot' };

  it('仓库键必须是小写 owner/name', () => {
    expect(() =>
      parseReposConfig({ bot, repos: { 'Owner/Name': { code_repo: 'a/b' } } }),
    ).toThrow(ConfigError);
    expect(() => parseReposConfig({ bot, repos: { 'not-a-slug': { code_repo: 'a/b' } } })).toThrow(
      ConfigError,
    );
  });

  it('缺省值补齐', () => {
    const config = parseReposConfig({ bot, repos: { 'a/b': { code_repo: 'c/d' } } });
    const repo = config.repos['a/b'];
    expect(repo?.code_ref_mode).toBe('tag');
    expect(repo?.fallback_ref).toBe('master');
    expect(repo?.triage.remove_after_triage).toBe(true);
  });
});

describe('parseBudgetsConfig', () => {
  it('缺省 max_issue_age_days 为 7', () => {
    const budgets = parseBudgetsConfig(MINIMAL_BUDGETS);
    expect(budgetDefaults(budgets).max_issue_age_days).toBe(7);
    expect(budgetDefaults(budgets).requested_stale_minutes).toBe(70);
  });

  it('残留的配额字段导致校验失败', () => {
    const raw = {
      defaults: { ...MINIMAL_BUDGETS.defaults, per_issue_per_hour: 1 },
    };
    expect(() => parseBudgetsConfig(raw)).toThrow(ConfigError);
  });

  it('l2 仍带 max_turns 时校验失败', () => {
    const raw = {
      defaults: {
        ...MINIMAL_BUDGETS.defaults,
        l2: { ...MINIMAL_BUDGETS.defaults.l2, max_turns: 3 },
      },
    };
    expect(() => parseBudgetsConfig(raw)).toThrow(ConfigError);
  });
});
