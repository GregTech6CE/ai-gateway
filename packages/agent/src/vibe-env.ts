/**
 * ACP 子进程的运行环境。
 *
 * 子进程只拿到 OS 基线变量与一个模型 key；`MODEL_KEY_*`、GitHub 凭据与其他环境
 * 变量都不进入子进程。`mistral-vibe` preset 在临时目录生成隔离的 `VIBE_HOME`：
 * 关闭遥测，预信任工作区，并用只读 agent profile 收敛内置工具。
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 允许透传给 ACP 子进程的系统变量；不包含任何 `MODEL_KEY_*`。 */
const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
] as const;

export type AcpPreset = 'generic' | 'mistral-vibe';

export interface AcpChildEnvOptions {
  readonly preset: AcpPreset;
  /** 当前入口的模型 key；空串表示不注入。 */
  readonly apiKey?: string;
  /** 把 key 注入到子进程的哪个变量；mistral-vibe 固定为 `MISTRAL_API_KEY`。 */
  readonly apiKeyTargetEnv?: string;
  /** ACP 会话的工作目录，也是 `mistral-vibe` 预信任的目录。 */
  readonly cwd: string;
  /** 入口声明的模型名，写入 Vibe 的 `active_model`。 */
  readonly model?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export interface AcpChildEnv {
  readonly env: Record<string, string>;
  cleanup(): void;
}

function baseEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') {
      env[key] = value;
    }
  }
  return env;
}

/** TOML 基本字符串：JSON 的转义集覆盖路径里会出现的字符。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function vibeConfig(model: string | undefined): string {
  const lines = [
    'enable_telemetry = false',
    'enable_auto_approve = false',
    'enable_connectors = false',
    'enable_mcp = true',
    'enable_background_processes = false',
    'enable_subagents = false',
    'default_approval_policy = "ask"',
    'outside_workdir = "deny"',
    'default_agent = "readonly"',
  ];
  if (model) {
    lines.push(`active_model = ${tomlString(model)}`);
  }
  lines.push(
    '',
    '[tools.write_file]',
    'permission = "never"',
    '',
    '[tools.edit]',
    'permission = "never"',
    '',
    '[tools.bash]',
    'permission = "never"',
    '',
  );
  return lines.join('\n');
}

const READONLY_AGENT = [
  'display_name = "Read Only"',
  'description = "只读检索与文件读取，不写文件、不执行命令"',
  // vibe-acp 3.1.4 将名为 gt6-readonly 的 MCP 工具归一化为 gt6_readonly_<tool> 后再按 enabled_tools 过滤。
  'enabled_tools = ["read_file", "skill", "gt6_readonly_list_files", "gt6_readonly_grep_search", "gt6_readonly_read_file", "gt6_readonly_git_log", "gt6_readonly_git_diff"]',
  '',
].join('\n');

function lstatIfExists(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/**
 * 为删除补齐权限：目录需要读写与执行，文件需要写。
 *
 * 目录补 `0o700` 而不是只补写与执行位：无读位的目录会让 `readdirSync`
 * 失败，子项就永远删不掉。
 * 只使用 `lstatSync`，符号链接一律跳过，避免把权限改到链接目标上。
 */
function makeRemovable(target: string): void {
  const stats = lstatIfExists(target);
  if (!stats || stats.isSymbolicLink()) {
    return;
  }
  if (stats.isDirectory()) {
    try {
      chmodSync(target, (stats.mode & 0o777) | 0o700);
    } catch {
      // 继续尝试子项；删除阶段仍会整体兜底
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(target);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      makeRemovable(join(target, entry));
    }
    return;
  }
  if (stats.isFile()) {
    try {
      chmodSync(target, (stats.mode & 0o777) | 0o200);
    } catch {
      // 删除阶段仍会整体兜底
    }
  }
}

function writeVibeHome(cwd: string, model: string | undefined): string {
  const home = mkdtempSync(join(tmpdir(), 'gt6-vibe-'));
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'config.toml'), vibeConfig(model), 'utf8');
  writeFileSync(
    join(home, 'trusted_folders.toml'),
    `trusted = [${tomlString(resolve(cwd))}]\nuntrusted = []\n`,
    'utf8',
  );
  writeFileSync(join(home, 'agents', 'readonly.toml'), READONLY_AGENT, 'utf8');
  return home;
}

/** 构造 ACP 子进程环境；返回值必须用 `cleanup` 结束，以删除隔离目录。 */
export function prepareAcpChildEnv(options: AcpChildEnvOptions): AcpChildEnv {
  const env = baseEnv(options.baseEnv ?? process.env);
  const key = (options.apiKey ?? '').trim();
  if (key) {
    const target =
      options.preset === 'mistral-vibe'
        ? 'MISTRAL_API_KEY'
        : (options.apiKeyTargetEnv ?? '');
    if (target) {
      env[target] = key;
    }
  }
  if (options.preset !== 'mistral-vibe') {
    return { env, cleanup: () => {} };
  }
  const home = writeVibeHome(options.cwd, options.model);
  env.VIBE_HOME = home;
  return {
    env,
    cleanup: () => {
      try {
        makeRemovable(home);
        rmSync(home, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不应覆盖已完成的分析结果；残留交给系统回收。
      }
    },
  };
}
