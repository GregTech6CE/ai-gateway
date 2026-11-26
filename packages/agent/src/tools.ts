/**
 * OpenAI 兼容驱动的代码工作区工具集：直接复用 `readonly-tools.ts` 的 5 个只读工具基线。
 *
 * 与 ACP 侧挂载的 `gt6-readonly` MCP 共享同一套多根目录路径校验、防注入参数约束、
 * 15 秒超时与 64 KB 流式内存截断，不开放任意 shell 或文件写入。
 */
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import {
  DEFAULT_GIT_LOG_MAX_COUNT,
  DEFAULT_GREP_MAX_MATCHES,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_READ_LIMIT,
  MAX_GIT_LOG_COUNT,
  MAX_GREP_CONTEXT_LINES,
  MAX_GREP_MATCHES,
  MAX_LIST_ENTRIES,
  MAX_READ_LIMIT,
  ToolError,
  gitDiffTool,
  gitLogTool,
  grepSearchTool,
  listFilesTool,
  readFileTool,
  resolveInside,
  rootsFromWorkspace,
  type ReadonlyRoots,
  type ReadonlyToolExecOptions,
} from './readonly-tools.ts';

export { ToolError, resolveInside, rootsFromWorkspace, type ReadonlyRoots };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodeToolsOptions {
  /** 工作区根目录；未显式传入 `roots` 时自动推导 `code/`、`inputs/`、`outputs/`。 */
  readonly root: string;
  readonly roots?: ReadonlyRoots;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly rgBin?: string;
  readonly gitBin?: string;
}

/**
 * 构造 OpenAI 兼容驱动使用的 5 个只读工具。
 *
 * 每个工具内部捕获错误并返回 `{ error }`，把拒绝原因交回模型以便换用合法路径或参数。
 * 返回类型显式写为 `ToolSet`，避免推断类型泄露 pnpm 内部路径（TS2742）。
 */
export function createCodeTools(options: CodeToolsOptions): ToolSet {
  const roots = options.roots ?? rootsFromWorkspace(options.root);
  const execOptions: ReadonlyToolExecOptions = {
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    env: options.env,
    rgBin: options.rgBin,
    gitBin: options.gitBin,
  };

  const listFiles = tool({
    description:
      '列出允许目录（code/、inputs/、outputs/）内的文件；默认 path 为 code/current，支持可选 glob 与 max_entries（默认 200，上限 500）。',
    inputSchema: z.object({
      path: z.string().default('code/current').describe('相对工作区的目录路径'),
      glob: z.string().optional().describe('可选 glob 过滤，如 *.java，禁止以 - 开头'),
      max_entries: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_ENTRIES)
        .default(DEFAULT_LIST_MAX_ENTRIES),
    }),
    execute: async ({ path, glob, max_entries }) => {
      try {
        return await listFilesTool(roots, { path, glob, max_entries }, execOptions);
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const grepSearch = tool({
    description:
      '在允许目录（code/、inputs/、outputs/）内按正则搜索文本（大小写不敏感），支持 glob、files_only、context_lines（0–5）与 max_matches（默认 60，上限 100）。',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('正则表达式'),
      path: z.string().default('code/current').describe('搜索起点'),
      glob: z.string().optional().describe('可选 glob 过滤，禁止以 - 开头'),
      files_only: z.boolean().default(false).describe('仅返回命中文件路径'),
      context_lines: z.number().int().min(0).max(MAX_GREP_CONTEXT_LINES).default(0),
      max_matches: z
        .number()
        .int()
        .min(1)
        .max(MAX_GREP_MATCHES)
        .default(DEFAULT_GREP_MAX_MATCHES),
    }),
    execute: async ({ pattern, path, glob, files_only, context_lines, max_matches }) => {
      try {
        return await grepSearchTool(
          roots,
          { pattern, path, glob, files_only, context_lines, max_matches },
          execOptions,
        );
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const readFile = tool({
    description:
      '按行读取允许目录（code/、inputs/、outputs/）内的文本文件，返回带行号文本与 total_lines；拒绝二进制与超大文件。',
    inputSchema: z.object({
      path: z.string().min(1).describe('相对工作区的文件路径'),
      offset: z.number().int().min(1).default(1).describe('起始行号（1 起）'),
      limit: z.number().int().min(1).max(MAX_READ_LIMIT).default(DEFAULT_READ_LIMIT),
    }),
    execute: async ({ path, offset, limit }) => {
      try {
        return readFileTool(roots, { path, offset, limit });
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const gitLog = tool({
    description:
      '查看仓库提交历史（默认 code/current），支持可选 path、ref、grep 与 max_count（默认 10，上限 30）。',
    inputSchema: z.object({
      repo: z.string().default('code/current').describe('仓库目录路径'),
      path: z.string().optional().describe('可选仓库内相对路径'),
      ref: z.string().optional().describe('可选 git ref 或区间，禁止以 - 开头'),
      grep: z.string().optional().describe('可选提交信息过滤关键字'),
      max_count: z
        .number()
        .int()
        .min(1)
        .max(MAX_GIT_LOG_COUNT)
        .default(DEFAULT_GIT_LOG_MAX_COUNT),
    }),
    execute: async ({ repo, path, ref, grep, max_count }) => {
      try {
        return await gitLogTool(roots, { repo, path, ref, grep, max_count }, execOptions);
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  const gitDiff = tool({
    description:
      '查看仓库差异（base/head）或单次提交改动（commit），支持可选 path 与 stat_only（默认 false）。',
    inputSchema: z.object({
      repo: z.string().default('code/current').describe('仓库目录路径'),
      base: z.string().optional().describe('基线 ref，禁止以 - 开头'),
      head: z.string().optional().describe('目标 ref，禁止以 - 开头'),
      commit: z.string().optional().describe('单次提交 ref，与 base/head 互斥'),
      path: z.string().optional().describe('可选仓库内相对路径'),
      stat_only: z.boolean().default(false).describe('仅输出 diffstat'),
    }),
    execute: async ({ repo, base, head, commit, path, stat_only }) => {
      try {
        return await gitDiffTool(
          roots,
          { repo, base, head, commit, path, stat_only },
          execOptions,
        );
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  });

  return {
    list_files: listFiles,
    grep_search: grepSearch,
    read_file: readFile,
    git_log: gitLog,
    git_diff: gitDiff,
  };
}
