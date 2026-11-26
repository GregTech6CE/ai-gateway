/**
 * 统一的 5 只读工具基线：
 * - `list_files`（底层 `rg --files --no-config`，禁 `--follow`）
 * - `grep_search`（底层 `rg --no-config --max-filesize 1M -i -- <pattern> <path>`）
 * - `read_file`（拒绝二进制与超大文件，返回带行号文本与 `total_lines`）
 * - `git_log`（底层 `git -C <repo> --no-pager log`，白名单 `ref`，`path` 在 `--` 后）
 * - `git_diff`（底层 `git -C <repo> --no-pager diff/show --no-ext-diff --no-textconv`）
 *
 * 多根目录安全边界：所有路径必须落在允许根集合（`code/`、`inputs/`、`outputs/`）内，
 * 拒绝空字节、绝对路径、`..`、符号链接逃逸、`.git` 与 `.env`。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  boundedExec,
} from './bounded-exec.ts';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export const ALLOWED_ROOT_NAMES = ['code', 'inputs', 'outputs'] as const;
export type AllowedRootName = (typeof ALLOWED_ROOT_NAMES)[number];

export interface ReadonlyRoots {
  readonly code: string;
  readonly inputs: string;
  readonly outputs: string;
}

export interface ReadonlyToolExecOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly rgBin?: string;
  readonly gitBin?: string;
}

export const DEFAULT_LIST_MAX_ENTRIES = 200;
export const MAX_LIST_ENTRIES = 500;
export const DEFAULT_GREP_MAX_MATCHES = 60;
export const MAX_GREP_MATCHES = 100;
export const MAX_GREP_CONTEXT_LINES = 5;
export const DEFAULT_READ_LIMIT = 200;
export const MAX_READ_LIMIT = 500;
export const MAX_READ_FILE_BYTES = 1_000_000;
export const DEFAULT_GIT_LOG_MAX_COUNT = 10;
export const MAX_GIT_LOG_COUNT = 30;

const ALLOWED_ROOT_SET = new Set<string>(ALLOWED_ROOT_NAMES);
const GLOB_ALLOWED_PATTERN = /^[A-Za-z0-9._*?[\]{}/+@~-]+$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/+~^-]{0,127}$/;

const RG_SAFETY_EXCLUDE_GLOBS = [
  '--glob',
  '!.git',
  '--glob',
  '!.git/**',
  '--glob',
  '!.env',
  '--glob',
  '!.env.*',
  '--glob',
  '!**/.env',
  '--glob',
  '!**/.env.*',
  '--glob',
  '!**/*.env',
  '--glob',
  '!.envrc',
  '--glob',
  '!**/.envrc',
] as const;

/** 从单个工作区根目录推导三个允许根目录：`code/`、`inputs/`、`outputs/`。 */
export function rootsFromWorkspace(root: string): ReadonlyRoots {
  const base = resolve(root);
  return {
    code: join(base, 'code'),
    inputs: join(base, 'inputs'),
    outputs: join(base, 'outputs'),
  };
}

function normalizeRoots(rootsOrWorkspace: ReadonlyRoots | string): ReadonlyRoots {
  if (typeof rootsOrWorkspace === 'string') {
    return rootsFromWorkspace(rootsOrWorkspace);
  }
  return {
    code: resolve(rootsOrWorkspace.code),
    inputs: resolve(rootsOrWorkspace.inputs),
    outputs: resolve(rootsOrWorkspace.outputs),
  };
}

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

function isPathInside(base: string, target: string): boolean {
  if (process.platform === 'win32') {
    const baseLower = base.toLowerCase();
    const targetLower = target.toLowerCase();
    return targetLower === baseLower || targetLower.startsWith(`${baseLower}${sep}`);
  }
  return target === base || target.startsWith(`${base}${sep}`);
}

/** 判断单个路径段是否命中 `.git` 或 `.env` 禁区。 */
function isForbiddenSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower === '.git') {
    return true;
  }
  if (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.env') ||
    lower === '.envrc' ||
    lower.startsWith('.envrc.') ||
    lower.endsWith('.envrc')
  ) {
    return true;
  }
  return false;
}

function hasControlChars(value: string): boolean {
  return /[\0\r\n]/.test(value);
}

export interface ResolvedInsidePath {
  readonly rootName: AllowedRootName;
  readonly rootDir: string;
  readonly realRootDir: string;
  readonly logicalPath: string;
  readonly targetPath: string;
  readonly realPath: string;
}

function nearestExistingAncestor(target: string): string | undefined {
  let current = target;
  while (true) {
    if (existsSync(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * 解析相对路径并校验多根目录安全边界。
 *
 * 只允许落在 `code/`、`inputs/`、`outputs/` 下；拒绝空字节、绝对路径、`..`、
 * `realpathSync` 符号链接逃逸、`.git` 与 `.env`。
 */
export function resolveInsideDetailed(
  rootsOrWorkspace: ReadonlyRoots | string,
  candidate: string,
): ResolvedInsidePath {
  const roots = normalizeRoots(rootsOrWorkspace);
  if (typeof candidate !== 'string' || candidate.trim() === '' || hasControlChars(candidate)) {
    throw new ToolError('路径为空或包含非法字符');
  }
  const normalized = toPosix(candidate).replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ToolError(`拒绝绝对路径: ${candidate}`);
  }
  const rawSegments = normalized.split('/');
  if (rawSegments.some((segment) => segment === '..')) {
    throw new ToolError(`拒绝路径逃逸: ${candidate}`);
  }
  const segments = rawSegments.filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) {
    throw new ToolError(`路径必须位于 code/、inputs/ 或 outputs/ 下: ${candidate}`);
  }

  const rootCandidate = segments[0]!;
  if (!ALLOWED_ROOT_SET.has(rootCandidate)) {
    throw new ToolError(`路径不在允许根集合（code/、inputs/、outputs/）内: ${candidate}`);
  }
  const rootName = rootCandidate as AllowedRootName;

  for (const segment of segments) {
    if (isForbiddenSegment(segment)) {
      throw new ToolError(`拒绝访问受限路径: ${candidate}`);
    }
  }

  const rootDir = resolve(roots[rootName]);
  const subSegments = segments.slice(1);
  const targetPath = subSegments.length > 0 ? resolve(rootDir, ...subSegments) : rootDir;
  if (!isPathInside(rootDir, targetPath)) {
    throw new ToolError(`拒绝路径逃逸: ${candidate}`);
  }

  let realRootDir: string;
  try {
    realRootDir = realpathSync(rootDir);
  } catch {
    throw new ToolError(`允许根目录不存在: ${rootName}/`);
  }

  let realPath: string;
  if (existsSync(targetPath)) {
    try {
      realPath = realpathSync(targetPath);
    } catch {
      throw new ToolError(`无法解析路径: ${candidate}`);
    }
    if (!isPathInside(realRootDir, realPath)) {
      throw new ToolError(`拒绝符号链接逃逸: ${candidate}`);
    }
    const realRel = toPosix(relative(realRootDir, realPath));
    if (realRel !== '' && realRel.split('/').some((segment) => isForbiddenSegment(segment))) {
      throw new ToolError(`拒绝符号链接指向受限路径: ${candidate}`);
    }
  } else {
    const ancestor = nearestExistingAncestor(targetPath);
    if (ancestor) {
      let realAncestor: string;
      try {
        realAncestor = realpathSync(ancestor);
      } catch {
        throw new ToolError(`无法解析路径: ${candidate}`);
      }
      if (!isPathInside(realRootDir, realAncestor)) {
        throw new ToolError(`拒绝符号链接逃逸: ${candidate}`);
      }
      const ancestorRel = toPosix(relative(realRootDir, realAncestor));
      if (
        ancestorRel !== '' &&
        ancestorRel.split('/').some((segment) => isForbiddenSegment(segment))
      ) {
        throw new ToolError(`拒绝符号链接指向受限路径: ${candidate}`);
      }
    }
    realPath = targetPath;
  }

  return {
    rootName,
    rootDir,
    realRootDir,
    logicalPath: segments.join('/'),
    targetPath,
    realPath,
  };
}

/** 校验并解析到允许根集合内的绝对路径。 */
export function resolveInside(
  rootsOrWorkspace: ReadonlyRoots | string,
  candidate: string,
): string {
  return resolveInsideDetailed(rootsOrWorkspace, candidate).targetPath;
}

function validateGlob(glob: string): string {
  if (typeof glob !== 'string' || glob.trim() === '' || hasControlChars(glob)) {
    throw new ToolError('glob 为空或包含非法字符');
  }
  if (glob.length > 200) {
    throw new ToolError('glob 过长');
  }
  if (glob.startsWith('-')) {
    throw new ToolError(`拒绝以 - 开头的 glob: ${glob}`);
  }
  if (glob.startsWith('!')) {
    throw new ToolError(`拒绝取反 glob: ${glob}`);
  }
  if (glob.startsWith('/') || glob.includes('\\') || /^[A-Za-z]:/.test(glob)) {
    throw new ToolError(`拒绝非法路径形态的 glob: ${glob}`);
  }
  if (!GLOB_ALLOWED_PATTERN.test(glob)) {
    throw new ToolError(`glob 包含非法字符: ${glob}`);
  }
  const segments = glob.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ToolError(`glob 不允许包含 ..: ${glob}`);
  }
  if (segments.some((segment) => isForbiddenSegment(segment)) || /(?:^|\/)\.(?:git|env)/i.test(glob)) {
    throw new ToolError(`glob 不允许匹配受限路径: ${glob}`);
  }
  return glob;
}

function validateGitRef(ref: string, allowRange: boolean): string {
  if (typeof ref !== 'string' || ref.trim() === '' || hasControlChars(ref)) {
    throw new ToolError('git ref 为空或包含非法字符');
  }
  if (ref.startsWith('-')) {
    throw new ToolError(`拒绝以 - 开头的 git ref: ${ref}`);
  }
  if (!GIT_REF_PATTERN.test(ref)) {
    throw new ToolError(`非法 git ref: ${ref}`);
  }
  if (ref.includes('@{') || ref.endsWith('.') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new ToolError(`非法 git ref: ${ref}`);
  }
  if (!allowRange && ref.includes('..')) {
    throw new ToolError(`非法单点 git ref: ${ref}`);
  }
  return ref;
}

function validateRepoSubPath(realRepo: string, subPath: string): string {
  if (typeof subPath !== 'string' || subPath.trim() === '' || hasControlChars(subPath)) {
    throw new ToolError('仓库内路径为空或包含非法字符');
  }
  const normalized = toPosix(subPath).replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('-')) {
    throw new ToolError(`非法仓库内路径: ${subPath}`);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ToolError(`拒绝绝对路径: ${subPath}`);
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new ToolError(`拒绝路径逃逸: ${subPath}`);
  }
  if (segments.some((segment) => isForbiddenSegment(segment))) {
    throw new ToolError(`拒绝访问受限路径: ${subPath}`);
  }
  const joined = segments.join('/');
  const resolved = resolve(realRepo, joined);
  if (!isPathInside(realRepo, resolved)) {
    throw new ToolError(`拒绝路径逃逸: ${subPath}`);
  }
  if (existsSync(resolved)) {
    let realTarget: string;
    try {
      realTarget = realpathSync(resolved);
    } catch {
      throw new ToolError(`无法解析路径: ${subPath}`);
    }
    if (!isPathInside(realRepo, realTarget)) {
      throw new ToolError(`拒绝符号链接逃逸: ${subPath}`);
    }
    const rel = toPosix(relative(realRepo, realTarget));
    if (rel !== '' && rel.split('/').some((segment) => isForbiddenSegment(segment))) {
      throw new ToolError(`拒绝符号链接指向受限路径: ${subPath}`);
    }
  }
  return joined;
}

function normalizeBoundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
  clampMax = true,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolError(`${name} 必须是整数`);
  }
  if (value < min) {
    throw new ToolError(`${name} 不能小于 ${min}`);
  }
  if (!clampMax && value > max) {
    throw new ToolError(`${name} 不能大于 ${max}`);
  }
  return Math.min(value, max);
}

function stripLeadingDotSlash(value: string): string {
  const posix = toPosix(value);
  return posix.startsWith('./') ? posix.slice(2) : posix;
}

function joinLogical(base: string, rel: string): string {
  const cleaned = stripLeadingDotSlash(rel);
  return cleaned === '' || cleaned === '.' ? base : `${base}/${cleaned}`;
}

export interface ListFilesInput {
  readonly path?: string;
  readonly glob?: string;
  readonly max_entries?: number;
}

export interface ListFilesResult {
  readonly path: string;
  readonly entries: string[];
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/** 列出目录下的文件；底层使用 `rg --files --no-config`，不跟随符号链接。 */
export async function listFilesTool(
  roots: ReadonlyRoots | string,
  input: ListFilesInput = {},
  execOptions: ReadonlyToolExecOptions = {},
): Promise<ListFilesResult> {
  const resolved = resolveInsideDetailed(roots, input.path ?? 'code/current');
  let stats;
  try {
    stats = statSync(resolved.realPath);
  } catch {
    throw new ToolError(`目录不存在: ${resolved.logicalPath}`);
  }
  if (!stats.isDirectory()) {
    throw new ToolError(`不是目录: ${resolved.logicalPath}`);
  }

  const maxEntries = normalizeBoundedInt(
    input.max_entries,
    DEFAULT_LIST_MAX_ENTRIES,
    1,
    MAX_LIST_ENTRIES,
    'max_entries',
  );
  const args: string[] = ['--files', '--no-config', '--no-ignore-parent'];
  if (input.glob !== undefined && input.glob !== '') {
    args.push('--glob', validateGlob(input.glob));
  }
  args.push(...RG_SAFETY_EXCLUDE_GLOBS, '--', '.');

  const result = await boundedExec(execOptions.rgBin ?? 'rg', args, {
    cwd: resolved.realPath,
    timeoutMs: execOptions.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxOutputBytes: execOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    env: execOptions.env,
  });

  if (result.exit_code !== 0 && result.exit_code !== 1 && !result.truncated && !result.timed_out) {
    throw new ToolError(`rg 执行失败: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  }

  const rawLines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const entries = rawLines
    .map((line) => joinLogical(resolved.logicalPath, line))
    .filter((entry) => !entry.split('/').some((segment) => isForbiddenSegment(segment)));
  entries.sort((left, right) => left.localeCompare(right));

  const clipped = entries.length > maxEntries;
  return {
    path: resolved.logicalPath,
    entries: clipped ? entries.slice(0, maxEntries) : entries,
    truncated: result.truncated || clipped,
    timed_out: result.timed_out,
  };
}

export interface GrepSearchInput {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly files_only?: boolean;
  readonly context_lines?: number;
  readonly max_matches?: number;
}

export interface GrepSearchResult {
  readonly path: string;
  readonly files?: string[];
  readonly matches?: string[];
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/** 按正则检索文本；底层 `rg --no-config --max-filesize 1M -i` 并以 `--` 隔离模式与路径。 */
export async function grepSearchTool(
  roots: ReadonlyRoots | string,
  input: GrepSearchInput,
  execOptions: ReadonlyToolExecOptions = {},
): Promise<GrepSearchResult> {
  if (typeof input.pattern !== 'string' || input.pattern === '' || hasControlChars(input.pattern)) {
    throw new ToolError('pattern 不能为空或包含控制字符');
  }
  if (input.pattern.length > 500) {
    throw new ToolError('pattern 过长');
  }

  const resolved = resolveInsideDetailed(roots, input.path ?? 'code/current');
  let stats;
  try {
    stats = statSync(resolved.realPath);
  } catch {
    throw new ToolError(`路径不存在: ${resolved.logicalPath}`);
  }
  const isFile = stats.isFile();
  if (!isFile && !stats.isDirectory()) {
    throw new ToolError(`路径既不是文件也不是目录: ${resolved.logicalPath}`);
  }

  const filesOnly = input.files_only === true;
  const contextLines = normalizeBoundedInt(
    input.context_lines,
    0,
    0,
    MAX_GREP_CONTEXT_LINES,
    'context_lines',
    false,
  );
  const maxMatches = normalizeBoundedInt(
    input.max_matches,
    DEFAULT_GREP_MAX_MATCHES,
    1,
    MAX_GREP_MATCHES,
    'max_matches',
  );

  const args: string[] = [
    '--no-config',
    '--no-ignore-parent',
    '--max-filesize',
    '1M',
    '-i',
    '--color',
    'never',
  ];
  if (filesOnly) {
    args.push('--files-with-matches');
  } else {
    args.push('--line-number', '--with-filename', '--no-heading');
    if (contextLines > 0) {
      args.push('-C', String(contextLines));
    }
  }
  if (input.glob !== undefined && input.glob !== '') {
    args.push('--glob', validateGlob(input.glob));
  }
  args.push(...RG_SAFETY_EXCLUDE_GLOBS);

  const cwd = isFile ? dirname(resolved.realPath) : resolved.realPath;
  const targetArg = isFile ? basename(resolved.realPath) : '.';
  // 以 `--` 隔离 pattern 与 path，避免 `--pre=sh` 等以 `-` 开头的模式被当成选项。
  args.push('--', input.pattern, targetArg);

  const result = await boundedExec(execOptions.rgBin ?? 'rg', args, {
    cwd,
    timeoutMs: execOptions.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxOutputBytes: execOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    env: execOptions.env,
  });

  if (result.exit_code !== 0 && result.exit_code !== 1 && !result.truncated && !result.timed_out) {
    throw new ToolError(`rg 搜索失败: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  }

  const lines = result.stdout.split(/\r?\n/).filter((line) => line !== '');
  if (filesOnly) {
    const files = lines
      .map((line) => (isFile ? resolved.logicalPath : joinLogical(resolved.logicalPath, line.trim())))
      .filter((entry) => !entry.split('/').some((segment) => isForbiddenSegment(segment)));
    const clipped = files.length > maxMatches;
    return {
      path: resolved.logicalPath,
      files: clipped ? files.slice(0, maxMatches) : files,
      truncated: result.truncated || clipped,
      timed_out: result.timed_out,
    };
  }

  const output: string[] = [];
  let matchCount = 0;
  let clipped = false;
  for (const rawLine of lines) {
    if (rawLine === '--') {
      if (output.length > 0) {
        output.push('--');
      }
      continue;
    }
    const matchEntry = /^([^:\r\n]+):(\d+):(.*)$/.exec(rawLine);
    if (matchEntry) {
      if (matchCount >= maxMatches) {
        clipped = true;
        break;
      }
      const filePart = isFile
        ? resolved.logicalPath
        : joinLogical(resolved.logicalPath, matchEntry[1]!);
      if (filePart.split('/').some((segment) => isForbiddenSegment(segment))) {
        continue;
      }
      matchCount += 1;
      output.push(`${filePart}:${matchEntry[2]!}:${matchEntry[3]!.slice(0, 300)}`);
      continue;
    }
    const contextEntry = /^([^-\r\n]+)-(\d+)-(.*)$/.exec(rawLine);
    if (contextEntry && contextLines > 0) {
      const filePart = isFile
        ? resolved.logicalPath
        : joinLogical(resolved.logicalPath, contextEntry[1]!);
      if (filePart.split('/').some((segment) => isForbiddenSegment(segment))) {
        continue;
      }
      output.push(`${filePart}-${contextEntry[2]!}-${contextEntry[3]!.slice(0, 300)}`);
    }
  }

  return {
    path: resolved.logicalPath,
    matches: output,
    truncated: result.truncated || clipped,
    timed_out: result.timed_out,
  };
}

export interface ReadFileInput {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadFileResult {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly total_lines: number;
  readonly content: string;
  readonly truncated: boolean;
}

/** 按行读取文本文件，拒绝二进制与超大文件，返回带行号文本与 `total_lines`。 */
export function readFileTool(
  roots: ReadonlyRoots | string,
  input: ReadFileInput,
  options: { readonly maxFileBytes?: number; readonly maxContentBytes?: number } = {},
): ReadFileResult {
  const resolved = resolveInsideDetailed(roots, input.path);
  let stats;
  try {
    stats = statSync(resolved.realPath);
  } catch {
    throw new ToolError(`文件不存在: ${resolved.logicalPath}`);
  }
  if (!stats.isFile()) {
    throw new ToolError(`不是文件: ${resolved.logicalPath}`);
  }
  const maxFileBytes = options.maxFileBytes ?? MAX_READ_FILE_BYTES;
  if (stats.size > maxFileBytes) {
    throw new ToolError(`文件过大（${stats.size} bytes，上限 ${maxFileBytes} bytes），请用 grep_search 定位`);
  }

  const offset = normalizeBoundedInt(input.offset, 1, 1, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = normalizeBoundedInt(input.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT, 'limit');

  const raw = readFileSync(resolved.realPath);
  if (raw.includes(0)) {
    throw new ToolError(`拒绝读取二进制文件: ${resolved.logicalPath}`);
  }

  const text = raw.toString('utf8').replace(/\r\n/g, '\n');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const totalLines = lines.length;
  const startIndex = offset - 1;
  const slice = lines.slice(startIndex, startIndex + limit);

  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const numbered: string[] = [];
  let usedBytes = 0;
  let contentTruncated = false;

  for (let index = 0; index < slice.length; index += 1) {
    const lineText = `${offset + index}: ${slice[index]!}`;
    const lineBytes = Buffer.byteLength(lineText, 'utf8') + (numbered.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > maxContentBytes) {
      contentTruncated = true;
      break;
    }
    numbered.push(lineText);
    usedBytes += lineBytes;
  }

  const endLine = numbered.length > 0 ? offset + numbered.length - 1 : offset - 1;
  const truncated = contentTruncated || startIndex + numbered.length < totalLines;
  return {
    path: resolved.logicalPath,
    start_line: offset,
    end_line: endLine,
    total_lines: totalLines,
    content: numbered.join('\n'),
    truncated,
  };
}

export interface GitLogInput {
  readonly repo?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly grep?: string;
  readonly max_count?: number;
}

export interface GitLogResult {
  readonly repo: string;
  readonly output: string;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/** 读取仓库提交日志；底层 `git -C <repo> --no-pager log`，路径置于 `--` 之后。 */
export async function gitLogTool(
  roots: ReadonlyRoots | string,
  input: GitLogInput = {},
  execOptions: ReadonlyToolExecOptions = {},
): Promise<GitLogResult> {
  const resolved = resolveInsideDetailed(roots, input.repo ?? 'code/current');
  let stats;
  try {
    stats = statSync(resolved.realPath);
  } catch {
    throw new ToolError(`仓库目录不存在: ${resolved.logicalPath}`);
  }
  if (!stats.isDirectory()) {
    throw new ToolError(`不是目录: ${resolved.logicalPath}`);
  }

  const maxCount = normalizeBoundedInt(
    input.max_count,
    DEFAULT_GIT_LOG_MAX_COUNT,
    1,
    MAX_GIT_LOG_COUNT,
    'max_count',
  );
  const args: string[] = [
    '-C',
    resolved.realPath,
    '--no-pager',
    'log',
    `--max-count=${maxCount}`,
    '--date=short',
    '--format=%h %ad %an | %s',
  ];

  if (input.grep !== undefined && input.grep !== '') {
    if (hasControlChars(input.grep) || input.grep.length > 200) {
      throw new ToolError('grep 过滤串非法或过长');
    }
    args.push(`--grep=${input.grep}`, '--regexp-ignore-case');
  }
  if (input.ref !== undefined && input.ref !== '') {
    args.push(validateGitRef(input.ref, true));
  }
  if (input.path !== undefined && input.path !== '') {
    args.push('--', validateRepoSubPath(resolved.realPath, input.path));
  }

  const result = await boundedExec(execOptions.gitBin ?? 'git', args, {
    timeoutMs: execOptions.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxOutputBytes: execOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    env: execOptions.env,
  });

  if (result.exit_code !== 0 && !result.truncated && !result.timed_out) {
    throw new ToolError(`git log 失败: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  }

  return {
    repo: resolved.logicalPath,
    output: result.stdout.trimEnd(),
    truncated: result.truncated,
    timed_out: result.timed_out,
  };
}

export interface GitDiffInput {
  readonly repo?: string;
  readonly base?: string;
  readonly head?: string;
  readonly commit?: string;
  readonly path?: string;
  readonly stat_only?: boolean;
}

export interface GitDiffResult {
  readonly repo: string;
  readonly output: string;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/** 读取仓库差异或单次提交改动；强制 `--no-ext-diff --no-textconv` 并以 `--` 隔离路径。 */
export async function gitDiffTool(
  roots: ReadonlyRoots | string,
  input: GitDiffInput = {},
  execOptions: ReadonlyToolExecOptions = {},
): Promise<GitDiffResult> {
  const resolved = resolveInsideDetailed(roots, input.repo ?? 'code/current');
  let stats;
  try {
    stats = statSync(resolved.realPath);
  } catch {
    throw new ToolError(`仓库目录不存在: ${resolved.logicalPath}`);
  }
  if (!stats.isDirectory()) {
    throw new ToolError(`不是目录: ${resolved.logicalPath}`);
  }

  const hasCommit = input.commit !== undefined && input.commit !== '';
  const hasBase = input.base !== undefined && input.base !== '';
  const hasHead = input.head !== undefined && input.head !== '';

  if (hasCommit && (hasBase || hasHead)) {
    throw new ToolError('commit 与 base/head 不能同时指定');
  }
  if (!hasCommit && !hasBase) {
    throw new ToolError('请指定 commit 或 base（及可选 head）');
  }

  const statOnly = input.stat_only === true;
  const args: string[] = ['-C', resolved.realPath, '--no-pager'];

  if (hasCommit) {
    const commit = validateGitRef(input.commit!, false);
    args.push('show', '--no-ext-diff', '--no-textconv', '--format=fuller');
    if (statOnly) {
      args.push('--stat');
    }
    args.push(commit);
  } else {
    const base = validateGitRef(input.base!, false);
    args.push('diff', '--no-ext-diff', '--no-textconv');
    if (statOnly) {
      args.push('--stat');
    }
    args.push(base);
    if (hasHead) {
      args.push(validateGitRef(input.head!, false));
    }
  }

  if (input.path !== undefined && input.path !== '') {
    args.push('--', validateRepoSubPath(resolved.realPath, input.path));
  }

  const result = await boundedExec(execOptions.gitBin ?? 'git', args, {
    timeoutMs: execOptions.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxOutputBytes: execOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    env: execOptions.env,
  });

  if (result.exit_code !== 0 && !result.truncated && !result.timed_out) {
    throw new ToolError(`git diff 失败: ${result.stderr.trim() || `exit ${result.exit_code}`}`);
  }

  return {
    repo: resolved.logicalPath,
    output: result.stdout.trimEnd(),
    truncated: result.truncated,
    timed_out: result.timed_out,
  };
}
