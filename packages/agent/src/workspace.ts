/**
 * 工作区准备：版本 ref 解析与附件预取。
 *
 * 两块逻辑都做统一加固：
 *
 * - zip 解压使用内置解析（`node:zlib` 的 `inflateRawSync` + `maxOutputLength`），
 *   解压炸弹在解压时就被 zlib 截断，而不是先展开再判断大小。
 * - 所有产出的路径一律 `/` 分隔，跨平台比较与提示词里引用同一套写法。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { redactDiagnostics } from '@gt6ce/shared';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** 统一为 `/` 分隔；提示词与清单里都用这一套。 */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 表单字段：取第一个非空、非 `_No response_` 的值。 */
export function formField(body: string, names: readonly string[]): string {
  for (const name of names) {
    const pattern = new RegExp(`^###\\s*${escapeRegExp(name)}\\s*\\n+\\s*(.+?)\\s*$`, 'm');
    const match = pattern.exec(body);
    const value = match?.[1]?.trim() ?? '';
    if (value && value !== '_No response_') {
      return value;
    }
  }
  return '';
}

/** issue 里报告的版本号；去掉前缀 `v`。 */
export function versionBase(body: string): string {
  const version = formField(body, ['模组版本 / Mod version', '模组版本', 'Mod version']).trim();
  return version.toLowerCase().startsWith('v') ? version.slice(1) : version;
}

export interface RefConfig {
  readonly code_ref_mode?: string;
  readonly tag_template?: string;
}

/** 由版本号推出候选 tag；非 tag 模式不产出候选。 */
export function versionCandidates(base: string, config: RefConfig): string[] {
  if (!base || (config.code_ref_mode ?? 'tag') !== 'tag') {
    return [];
  }
  const template = config.tag_template ?? 'v{version}';
  const candidates: string[] = [];
  const formatted = template.replaceAll('{version}', base);
  if (formatted) {
    candidates.push(formatted);
  }
  if (!candidates.includes(base)) {
    candidates.push(base);
  }
  return candidates;
}

/** 在远端 tag 集合里找第一个候选；没有就返回空串。 */
export function resolveVersionTag(
  base: string,
  tags: ReadonlySet<string> | undefined,
  config: RefConfig,
): string {
  if (!tags || tags.size === 0) {
    return '';
  }
  for (const candidate of versionCandidates(base, config)) {
    if (tags.has(candidate)) {
      return candidate;
    }
  }
  return '';
}

/** `git ls-remote --tags`：拿不到（网络、仓库不存在）时返回 undefined，由调用方降级。 */
export function listRemoteTags(options: {
  readonly repo: string;
  readonly gitBin?: string;
  readonly timeoutMs?: number;
}): Set<string> | undefined {
  try {
    const stdout = execFileSync(
      options.gitBin ?? 'git',
      ['ls-remote', '--tags', `https://github.com/${options.repo}.git`],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 30_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const tags = new Set<string>();
    for (const line of stdout.split('\n')) {
      const ref = line.split('\t').pop() ?? '';
      if (!ref.startsWith('refs/tags/')) {
        continue;
      }
      tags.add(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''));
    }
    return tags;
  } catch {
    return undefined;
  }
}

export interface ArtifactLimits {
  readonly maxAttachmentBytes: number;
  readonly maxTotalAttachmentBytes: number;
}

/** 附件文件名：只留安全字符，避免 URL 里的片段变成路径。 */
export function safeAttachmentName(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  const tail = withoutQuery.replace(/\/+$/, '').split('/').pop() ?? '';
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return cleaned || 'attachment.bin';
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 下载单个附件，带 Content-Length 预检与读取上限。 */
export async function downloadAttachment(options: {
  readonly url: string;
  readonly target: string;
  readonly maxBytes: number;
  readonly fetchImpl?: FetchLike;
}): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.url, {
      headers: { 'User-Agent': 'gt6ce-ai-gateway' },
      redirect: 'follow',
    });
  } catch (error) {
    throw new WorkspaceError(
      `下载失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new WorkspaceError(`下载失败: HTTP ${response.status}`);
  }
  const declared = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new WorkspaceError(`附件过大: ${declared} bytes`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > options.maxBytes) {
    throw new WorkspaceError(`附件超过上限: ${data.byteLength} bytes`);
  }
  mkdirSync(dirname(options.target), { recursive: true });
  writeFileSync(options.target, data);
  return data.byteLength;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/** 只解析中央目录：大小与偏移以它为准，本地头里的字段可能因 data descriptor 为 0。 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new WorkspaceError('不是合法的 zip：缺少中央目录结尾');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new WorkspaceError('zip 中央目录损坏');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function safeEntryPath(name: string): string | undefined {
  const normalized = toPosix(name);
  if (normalized === '' || normalized.endsWith('/')) {
    return undefined;
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return undefined;
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    return undefined;
  }
  return segments.join('/');
}

/**
 * 解压 zip 到目录，返回实际写出的文件。
 *
 * 三道防护：路径穿越（绝对路径、盘符、`..`）直接跳过；单条目注入 `maxOutputLength`
 * 让解压炸弹在 zlib 内被截断；累计解压量超过上限立刻抛出。
 */
export function extractZip(
  buffer: Buffer,
  targetDir: string,
  limits: ArtifactLimits,
): { files: string[]; totalBytes: number } {
  const entries = readZipEntries(buffer);
  const files: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const relativePath = safeEntryPath(entry.name);
    if (!relativePath) {
      continue;
    }
    const remaining = limits.maxTotalAttachmentBytes - totalBytes;
    if (remaining <= 0) {
      throw new WorkspaceError('压缩包解压总量超过上限');
    }
    if (entry.uncompressedSize > remaining) {
      throw new WorkspaceError(`解压总量超过上限: ${entry.name}`);
    }
    const localOffset = entry.localOffset;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new WorkspaceError(`zip 本地头损坏: ${entry.name}`);
    }
    const nameLength = buffer.readUInt16LE(localOffset + 26);
    const extraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) {
      throw new WorkspaceError(`zip 数据越界: ${entry.name}`);
    }
    const raw = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (entry.method === 0) {
      content = raw;
    } else if (entry.method === 8) {
      try {
        content = inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) });
      } catch (error) {
        throw new WorkspaceError(
          `解压失败: ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      throw new WorkspaceError(`不支持的压缩方式 ${entry.method}: ${entry.name}`);
    }
    if (content.byteLength > remaining) {
      throw new WorkspaceError(`解压总量超过上限: ${entry.name}`);
    }
    const destination = join(targetDir, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
    totalBytes += content.byteLength;
    files.push(relativePath);
  }
  return { files, totalBytes };
}

const TEXT_SUFFIXES = new Set(['.log', '.txt', '.json', '.md', '.cfg', '.toml', '.yaml', '.yml']);
const INTERESTING = /error|exception|crash|caused by|gregtech|warn|fail/i;
const MAX_DIGEST_SOURCE_BYTES = 400_000;
const MAX_DIGEST_LINES_PER_FILE = 120;
const MAX_DIGEST_LINES_EMITTED = 80;
const MAX_DIGEST_LINE_LENGTH = 500;

function listFilesRecursive(root: string): string[] {
  try {
    statSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  }
  return found.sort();
}

/** 日志摘要：按关键字挑选行，路径/IP/UUID 脱敏后再落盘。 */
export function buildLogDigest(options: {
  readonly logsDir: string;
  readonly baseDir: string;
}): string {
  const lines: string[] = ['# 日志摘要（已脱敏）', ''];
  for (const path of listFilesRecursive(options.logsDir)) {
    const suffix = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!TEXT_SUFFIXES.has(suffix)) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8').slice(0, MAX_DIGEST_SOURCE_BYTES);
    } catch {
      continue;
    }
    const picked = text
      .split('\n')
      .filter((line) => INTERESTING.test(line))
      .slice(0, MAX_DIGEST_LINES_PER_FILE);
    lines.push(`## ${toPosix(relative(options.baseDir, path))}`, '');
    for (const line of picked.slice(0, MAX_DIGEST_LINES_EMITTED)) {
      lines.push(redactDiagnostics(line).slice(0, MAX_DIGEST_LINE_LENGTH));
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface PrefetchResult {
  readonly notes: string[];
  readonly digest: string;
  readonly files: string[];
}

/**
 * 下载并解压 issue 附件，写出 `inputs/logs/README.md` 与 `outputs/log_digest.md`。
 *
 * 单个附件失败只记一行说明，不中断其余附件——日志不完整仍然可以给出「证据不足」的结论，
 * 而整次分析因此失败没有任何收益。
 */
export async function prefetchAttachments(options: {
  readonly root: string;
  readonly attachments: readonly string[];
  readonly limits: ArtifactLimits;
  readonly fetchImpl?: FetchLike;
}): Promise<PrefetchResult> {
  const logsDir = join(options.root, 'inputs', 'logs');
  const outputsDir = join(options.root, 'outputs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });

  const notes: string[] = ['# 附件清单', ''];
  const files: string[] = [];
  let total = 0;
  for (const url of options.attachments) {
    const name = safeAttachmentName(url);
    const target = join(logsDir, name);
    try {
      const size = await downloadAttachment({
        url,
        target,
        maxBytes: options.limits.maxAttachmentBytes,
        fetchImpl: options.fetchImpl,
      });
      total += size;
      if (total > options.limits.maxTotalAttachmentBytes) {
        throw new WorkspaceError('附件总量超过上限');
      }
      notes.push(`- ${name}`);
      files.push(toPosix(relative(options.root, target)));
      if (name.toLowerCase().endsWith('.zip')) {
        const extractDir = join(logsDir, name.replace(/\.zip$/i, ''));
        const extracted = extractZip(readFileSync(target), extractDir, options.limits);
        files.push(
          ...extracted.files.map((item) =>
            toPosix(relative(options.root, join(extractDir, item))),
          ),
        );
      }
    } catch (error) {
      notes.push(`- ${name}: 下载/解压失败 (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  writeFileSync(join(logsDir, 'README.md'), `${notes.join('\n')}\n`, 'utf8');
  const digest = buildLogDigest({ logsDir, baseDir: join(options.root, 'inputs') });
  writeFileSync(join(outputsDir, 'log_digest.md'), `${digest}\n`, 'utf8');
  return { notes, digest, files };
}
