/**
 * 代码工作区工具集：三个只读工具 + 一个受控 shell。
 *
 * 安全边界：
 *
 * - 只读工具把路径限制在工作区根目录内，拒绝绝对路径、盘符与 `..`；解析后还会用
 *   `realpath` 复查，防止通过符号链接逃逸。
 * - `run_bash` 不经过 shell：命令先按引号规则切成 argv，再校验可执行文件白名单。
 *   管道、重定向、命令替换这类元字符一律拒绝，避免模型借 shell 拿到未预期的能力。
 * - 子进程的 `env` 每次重建，只保留 `PATH`/`LANG`/`HOME`/`HTTP(S)_PROXY`；
 *   `MODEL_KEY_*` 与任何其他凭据在 `spawn` 之前就不存在于子进程环境中。
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** 子进程环境白名单：不放行任何密钥，`MODEL_KEY_*` 也在其中被剔除。 */
export const BASH_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
] as const;

/** 允许通过 `run_bash` 调用的可执行文件。 */
export const BASH_ALLOWED_COMMANDS = ['python3', 'node', 'curl', 'git'] as const;

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const DEFAULT_BASH_MAX_OUTPUT_BYTES = 64_000;

const DEFAULT_MAX_READ_BYTES = 200_000;
const DEFAULT_MAX_READ_LINES = 400;
const MAX_READ_LINES = 2_000;
const DEFAULT_MAX_LIST_ENTRIES = 300;
const DEFAULT_MAX_GREP_MATCHES = 60;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_MAX_FILES = 4_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist']);

function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
 * 把模型给的相对路径解析到工作区内。
 *
 * 先做字面检查（绝对路径、盘符、`..`），再对已存在的路径做 `realpath` 复查：
 * 符号链接指向区外时同样拒绝。
 */
export function resolveInside(base: string, candidate: string): string {
  if (!candidate || candidate.includes('\0')) {
    throw new ToolError('路径为空或包含非法字符');
  }
  const normalized = candidate.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ToolError(`拒绝绝对路径: ${candidate}`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new ToolError(`拒绝路径逃逸: ${candidate}`);
  }
  const root = resolve(base);
  const target = resolve(root, normalized);
  if (!isInside(root, target)) {
    throw new ToolError(`拒绝路径逃逸: ${candidate}`);
  }
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!isInside(realRoot, realTarget)) {
      throw new ToolError(`拒绝符号链接逃逸: ${candidate}`);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    // 目标不存在时 realpath 会失败；后续读取会给出更明确的错误。
  }
  return target;
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command.charAt(index);
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command.charAt(index);
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    if ('|&;<>()`'.includes(char) || (char === '$' && command.charAt(index + 1) === '(')) {
      throw new ToolError(`run_bash 不接受 shell 元字符: ${char}`);
    }
    current += char;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw new ToolError('引号未闭合');
  }
  if (tokenStarted) {
    args.push(current);
  }
  if (args.length === 0) {
    throw new ToolError('命令为空');
  }
  return args;
}

/** 只保留白名单里的环境变量；任何密钥都不会进入子进程。 */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASH_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export interface BashResult {
  readonly command: string;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

export interface RunBashOptions {
  readonly root: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowedCommands?: readonly string[];
}

/** 执行一条受控命令；超时与超量都会杀掉子进程并标记结果。 */
export async function runBash(command: string, options: RunBashOptions): Promise<BashResult> {
  const args = parseCommand(command);
  const executable = basename(args[0] ?? '');
  const allowed = options.allowedCommands ?? BASH_ALLOWED_COMMANDS;
  if (!allowed.includes(executable)) {
    throw new ToolError(`不允许的可执行文件: ${executable}`);
  }

  return await new Promise<BashResult>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args.slice(1), {
      cwd: options.root,
      env: sanitizedEnv(options.env ?? process.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const limit = options.maxOutputBytes ?? DEFAULT_BASH_MAX_OUTPUT_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= limit) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > limit) {
        truncated = true;
        return next.slice(0, limit);
      }
      return next;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (truncated) {
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(new ToolError(`启动失败: ${messageOf(error)}`));
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise({
        command,
        exit_code: code ?? -1,
        stdout,
        stderr,
        truncated,
        timed_out: timedOut,
      });
    });
  });
}

export interface CodeToolsOptions {
  /** 工作区根目录；所有路径都以它为基准。 */
  readonly root: string;
  readonly bashTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

function listEntries(root: string, directory: string, maxEntries: number): string[] {
  const entries: string[] = [];
  const stack: string[] = [directory];
  while (stack.length > 0 && entries.length < maxEntries) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    const children = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      if (entries.length >= maxEntries) {
        break;
      }
      if (child.name === '.git') {
        continue;
      }
      const path = join(current, child.name);
      entries.push(toPosix(relative(root, path)) + (child.isDirectory() ? '/' : ''));
      if (child.isDirectory() && !SKIP_DIRS.has(child.name)) {
        stack.push(path);
      }
    }
  }
  return entries;
}

/**
 * 构造工具集。
 *
 * 每个工具内部都捕获错误并返回 `{ error }`：把失败原因交回模型，让它换一条路径，
 * 而不是让整次生成因为一个越界路径直接中断。
 *
 * 返回类型显式写成 `ToolSet`：`tool()` 的推断类型会引用 pnpm 内部路径，声明文件
 * 无法生成（TS2742）。
 */
export function createCodeTools(options: CodeToolsOptions): ToolSet {
  const root = resolve(options.root);
  const realRoot = realpathSync(root);

  const insideRealRoot = (path: string): boolean => {
    try {
      return isInside(realRoot, realpathSync(path));
    } catch {
      return false;
    }
  };

  const listFiles = tool({
    description: '列出工作区内的文件与目录（递归，最多返回若干条）。path 为相对工作区根目录的路径。',
    inputSchema: z.object({
      path: z.string().default('.').describe('相对路径，默认为工作区根目录'),
      max_entries: z.number().int().min(1).max(1000).default(DEFAULT_MAX_LIST_ENTRIES),
    }),
    execute: async ({ path, max_entries }) => {
      try {
        const target = resolveInside(root, path);
        if (!statSync(target).isDirectory()) {
          throw new ToolError(`不是目录: ${path}`);
        }
        const entries = listEntries(root, target, max_entries);
        return { entries, truncated: entries.length >= max_entries };
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const readFile = tool({
    description: '读取工作区内的文本文件，按行截取。返回内容与总行数，便于引用 path:line。',
    inputSchema: z.object({
      path: z.string().describe('相对工作区根目录的文件路径'),
      offset: z.number().int().min(1).default(1).describe('起始行号（1 起）'),
      limit: z.number().int().min(1).max(MAX_READ_LINES).default(DEFAULT_MAX_READ_LINES),
    }),
    execute: async ({ path, offset, limit }) => {
      try {
        const target = resolveInside(root, path);
        const stats = statSync(target);
        if (!stats.isFile()) {
          throw new ToolError(`不是文件: ${path}`);
        }
        if (stats.size > DEFAULT_MAX_READ_BYTES) {
          throw new ToolError(`文件过大（${stats.size} bytes），请用 grep_search 定位片段`);
        }
        const text = readFileSync(target, 'utf8');
        if (text.includes('\0')) {
          throw new ToolError('文件包含二进制内容');
        }
        const lines = text.split('\n');
        const start = offset - 1;
        const slice = lines.slice(start, start + limit);
        return {
          path: toPosix(relative(root, target)),
          start_line: offset,
          end_line: offset + slice.length - 1,
          total_lines: lines.length,
          content: slice.join('\n'),
          truncated: start + slice.length < lines.length,
        };
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const grepSearch = tool({
    description: '在工作区内按正则搜索文本（大小写不敏感），返回 文件:行号 与命中行。',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('JavaScript 正则'),
      path: z.string().default('.').describe('搜索起点，相对工作区根目录'),
      max_results: z.number().int().min(1).max(200).default(DEFAULT_MAX_GREP_MATCHES),
    }),
    execute: async ({ pattern, path, max_results }) => {
      try {
        const target = resolveInside(root, path);
        const matcher = new RegExp(pattern, 'i');
        const matches: Array<{ file: string; line: number; text: string }> = [];
        let scanned = 0;
        let truncated = false;

        const visit = (file: string): void => {
          if (matches.length >= max_results || scanned >= GREP_MAX_FILES) {
            truncated = true;
            return;
          }
          scanned += 1;
          let text: string;
          try {
            if (statSync(file).size > GREP_MAX_FILE_BYTES) {
              return;
            }
            text = readFileSync(file, 'utf8');
          } catch {
            return;
          }
          if (text.includes('\0')) {
            return;
          }
          const lines = text.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            if (!matcher.test(line)) {
              continue;
            }
            matches.push({
              file: toPosix(relative(root, file)),
              line: index + 1,
              text: line.trim().slice(0, 300),
            });
            if (matches.length >= max_results) {
              truncated = true;
              return;
            }
          }
        };

        const walk = (current: string): void => {
          if (matches.length >= max_results || scanned >= GREP_MAX_FILES) {
            truncated = true;
            return;
          }
          // `code/current` 这类工作区内符号链接允许跟随，指向区外的链接直接跳过。
          if (!insideRealRoot(current)) {
            return;
          }
          const stats = statSync(current);
          if (stats.isFile()) {
            visit(current);
            return;
          }
          for (const child of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            if (SKIP_DIRS.has(child.name)) {
              continue;
            }
            walk(join(current, child.name));
          }
        };

        walk(target);
        return { matches, truncated };
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const runBashTool = tool({
    description:
      '在受控环境中执行一条命令。仅允许 python3 / node / curl / git，单次 30 秒、输出有上限，' +
      '子进程不继承任何密钥环境变量。不支持管道、重定向或命令替换；需要组合时请分多次调用。',
    inputSchema: z.object({
      command: z.string().min(1).describe('完整命令行，例如 git log --oneline -5'),
    }),
    execute: async ({ command }) => {
      try {
        return await runBash(command, {
          root,
          timeoutMs: options.bashTimeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          env: options.env,
        });
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  return {
    list_files: listFiles,
    read_file: readFile,
    grep_search: grepSearch,
    run_bash: runBashTool,
  };
}
