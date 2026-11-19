/**
 * CI 各阶段的公共设施：目录约定、JSON 读写、`$GITHUB_OUTPUT` 与入口判定。
 *
 * 这里只处理路径与文件，**不读取任何阶段专属的环境变量**。每个 job 在自己的文件里
 * 声明并读取所需变量，这样 `gate` 不可能意外拿到 `MODEL_KEY_*`。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { createLogger, type Logger } from '@gt6ce/shared';

export interface StageDirs {
  readonly root: string;
  readonly inputs: string;
  readonly outputs: string;
  readonly config: string;
  readonly prompts: string;
  readonly templates: string;
  readonly code: string;
}

export interface DirEnv {
  readonly CI_ROOT?: string;
  readonly CONFIG_DIR?: string;
  readonly INPUTS_DIR?: string;
  readonly OUTPUTS_DIR?: string;
  readonly PROMPTS_DIR?: string;
  readonly TEMPLATES_DIR?: string;
  readonly CODE_DIR?: string;
}

/** 目录约定集中在这里；工作流只设置 `CI_ROOT`，其余按默认相对路径展开。 */
export function resolveDirs(env: DirEnv = process.env, cwd: string = process.cwd()): StageDirs {
  const root = resolve(cwd, env.CI_ROOT ?? '.');
  const pick = (value: string | undefined, fallback: string): string =>
    value ? resolve(root, value) : join(root, fallback);
  return {
    root,
    inputs: pick(env.INPUTS_DIR, 'inputs'),
    outputs: pick(env.OUTPUTS_DIR, 'outputs'),
    config: pick(env.CONFIG_DIR, 'config'),
    prompts: pick(env.PROMPTS_DIR, 'prompts'),
    templates: pick(env.TEMPLATES_DIR, 'templates'),
    code: pick(env.CODE_DIR, 'code'),
  };
}

export function readJsonFile<T>(path: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeTextFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

export function requireEnv(source: NodeJS.ProcessEnv, name: string): string {
  const value = (source[name] ?? '').trim();
  if (!value) {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function optionalEnv(source: NodeJS.ProcessEnv, name: string): string {
  return (source[name] ?? '').trim();
}

/** 追加写入 `$GITHUB_OUTPUT`；没有该文件（本地运行）时静默跳过。 */
export function writeGithubOutput(
  values: Readonly<Record<string, string>>,
  outputPath: string | undefined = process.env.GITHUB_OUTPUT,
): void {
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value.replace(/\n/g, ' ')}`);
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * 是否为指定 job 的直接入口。
 *
 * 不能只比较 `import.meta.url` 与 `argv[1]`：`dist/index.js` 把所有 job 打进同一个
 * 文件，合并后每个模块的 `import.meta.url` 都等于入口文件，按 URL 判断会让所有 guard
 * 一起触发。改为比对入口文件名，`node dist/jobs/gate.js` 只在 gate 里为真，
 * `node dist/index.js gate` 只命中统一调度器。
 */
export function isJobEntry(name: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const base = entry.replaceAll('\\', '/').split('/').pop() ?? '';
  return base === `${name}.js` || base === `${name}.mjs` || base === `${name}.cjs`;
}

/** 收集给定环境变量名对应的非空值，用于日志脱敏。 */
export function secretValues(
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): string[] {
  const values: string[] = [];
  for (const name of names) {
    const value = source[name];
    if (value) {
      values.push(value);
    }
  }
  return values;
}

export function stageLogger(
  scope: string,
  secrets: readonly string[],
): Logger {
  return createLogger({
    scope,
    level: 'info',
    secrets,
    sink: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
}

/**
 * 启动阶段打印实际生效的目录。
 *
 * 每个 CI job 是独立进程，排查「加载了哪一份配置/提示词」时先看这一行。只记录路径，
 * 不读取也不打印任何凭据。
 */
export function logStageDirs(job: string, dirs: StageDirs): void {
  stageLogger(job, []).info('阶段启动', {
    root: dirs.root,
    config: dirs.config,
    prompts: dirs.prompts,
    templates: dirs.templates,
    inputs: dirs.inputs,
    outputs: dirs.outputs,
    code: dirs.code,
  });
}

/** 从 `MODEL_KEY_*` 里收集本次可用的 key，返回 name → value。 */
export function modelKeys(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('MODEL_KEY_') && value) {
      keys[name] = value;
    }
  }
  return keys;
}
