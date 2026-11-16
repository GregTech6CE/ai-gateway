/**
 * 输出产物扫描：发布前的最后一道确定性检查。
 *
 * 规则与旧版 supervisor 一致：递归扫描 `outputs/`，命中即就地脱敏；`result.json`
 * 由调用方在序列化前单独扫描，避免扫描结论写入自身形成循环。任一文件扫描失败时
 * 记录到 `failed`，工作流据此关闭 artifact 上传闸门。
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

import { redactText, scanText } from '@gt6ce/shared';

const MAX_SCAN_BYTES = 16_000_000;

export interface SecretScanResult {
  readonly ok: boolean;
  readonly hits: string[];
  readonly failed: string[];
}

export function emptyScanResult(): SecretScanResult {
  return { ok: true, hits: [], failed: [] };
}

/** 只读文件前缀，避免为一个超大产物把整个文件读进内存。 */
function readPrefix(path: string, maxBytes: number): { text: string; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return { text: buffer.toString('utf8'), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * 扫描并就地脱敏单个文件，返回是否命中。
 *
 * 不做分块：凭据模式与 PEM 私钥块都可能跨行。文件超过上限时只保留可扫描的前段，
 * 其余连同被切断的半行一起丢弃——未扫描的内容不进 artifact。
 */
export function scanFileInPlace(path: string, secrets: readonly string[]): boolean {
  const { text, size } = readPrefix(path, MAX_SCAN_BYTES);
  const oversized = size > MAX_SCAN_BYTES;
  const hits = scanText(text, secrets);
  if (hits.length === 0 && !oversized) {
    return false;
  }
  let content = text;
  if (oversized) {
    const cut = content.lastIndexOf('\n');
    content = cut >= 0 ? content.slice(0, cut + 1) : '';
  }
  let cleaned = redactText(content, secrets);
  if (oversized) {
    cleaned = `${cleaned.replace(/\n+$/, '')}\n[内容超过扫描上限，其余部分已丢弃]\n`;
  }
  writeFileSync(path, cleaned, 'utf8');
  return hits.length > 0;
}

function discard(path: string): void {
  try {
    writeFileSync(path, '[内容未能扫描，已丢弃]\n', 'utf8');
    return;
  } catch {
    // 退而删除
  }
  try {
    unlinkSync(path);
  } catch {
    // 什么都做不了时保留原文件，但已记入 failed
  }
}

function listFiles(root: string): string[] {
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

/** 递归扫描 outputs/；`skipNames` 里的文件名不参与（默认 result.json）。 */
export function scanOutputs(
  outputsDir: string,
  secrets: readonly string[],
  skipNames: readonly string[] = ['result.json'],
): SecretScanResult {
  const hits: string[] = [];
  const failed: string[] = [];
  let files: string[];
  try {
    files = listFiles(outputsDir);
  } catch {
    return emptyScanResult();
  }
  for (const path of files) {
    const name = basename(path);
    if (skipNames.includes(name)) {
      continue;
    }
    const relativePath = relative(outputsDir, path).replaceAll('\\', '/');
    try {
      if (scanFileInPlace(path, secrets)) {
        hits.push(relativePath);
      }
    } catch {
      hits.push(`${relativePath}（扫描失败）`);
      failed.push(relativePath);
      discard(path);
    }
  }
  return { ok: hits.length === 0 && failed.length === 0, hits, failed };
}

/** 合并两次扫描结果（例如上一轮 result 与当前轮）。 */
export function mergeScanResults(
  previous: SecretScanResult | undefined,
  current: SecretScanResult,
): SecretScanResult {
  const hits = [...new Set([...(previous?.hits ?? []), ...current.hits])];
  const failed = [...new Set([...(previous?.failed ?? []), ...current.failed])];
  return {
    ok: previous?.ok !== false && current.ok !== false && hits.length === 0,
    hits,
    failed,
  };
}

/** 序列化后的整体扫描，用于 result.json 自身。 */
export function scanJsonPayload(payload: unknown, secrets: readonly string[]): SecretScanResult {
  const text = JSON.stringify(payload);
  const hits = scanText(text, secrets);
  return { ok: hits.length === 0, hits: hits.length > 0 ? ['result.json'] : [], failed: [] };
}
