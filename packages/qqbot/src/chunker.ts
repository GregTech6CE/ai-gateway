/**
 * Markdown 感知的消息切分。
 *
 * QQ 单条消息有长度上限，超长内容必须拆分。按字符硬切会破坏三类结构：
 * 代码围栏失去闭合、表格丢失表头、段落被截断在词中间。这里的做法是先按
 * 「块」解析（围栏代码块 / 表格 / 普通文本），再按块装箱：
 *
 * - 普通文本：逐行贪心装箱，单行超长时按码点硬切；
 * - 围栏代码块：超长时拆成多段，每段补上开启围栏与闭合围栏；
 * - 表格：超长时拆分数据行，每段重复表头与分隔行。
 *
 * 无 Markdown 权限时的纯文本降级不在这里做（切分与降级是两件事），
 * 判定逻辑见 `errors.ts` 的 `isMarkdownPermissionError`，重发在 `gateway.ts`。
 */
import { DEFAULT_CHUNK_LENGTH } from './types.ts';

export interface ChunkOptions {
  /** 单条上限，默认 {@link DEFAULT_CHUNK_LENGTH}。低于 200 视为配置错误。 */
  readonly maxLength?: number;
}

interface Fence {
  /** 围栏标记本身，例如 ``` 或 ~~~。 */
  readonly marker: string;
  /** 围栏后的信息串，例如 `ts`。 */
  readonly info: string;
}

type Block =
  | { readonly kind: 'text'; readonly lines: readonly string[] }
  | { readonly kind: 'code'; readonly lines: readonly string[]; readonly fence: Fence }
  | { readonly kind: 'table'; readonly lines: readonly string[] };

const MIN_MAX_LENGTH = 200;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/;

function normalize(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').trimEnd();
}

function openingFence(line: string): Fence | undefined {
  const match = FENCE_PATTERN.exec(line);
  if (!match) {
    return undefined;
  }
  const marker = match[1] ?? '';
  const info = (match[2] ?? '').trimEnd();
  // CommonMark：反引号围栏的信息串里不允许再出现反引号。
  if (marker.startsWith('`') && info.includes('`')) {
    return undefined;
  }
  return { marker, info };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = CLOSING_FENCE_PATTERN.exec(line);
  if (!match) {
    return false;
  }
  const marker = match[1] ?? '';
  return marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.includes('-') && /^[|\s:-]+$/.test(trimmed);
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.split('|').length >= 3;
}

function isTableStart(lines: readonly string[], index: number): boolean {
  return (
    looksLikeTableRow(lines[index] ?? '') &&
    index + 1 < lines.length &&
    isTableSeparator(lines[index + 1] ?? '')
  );
}

/** 把行序列解析成块。空行只作为块分隔，不进入任何块。 */
function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const fence = openingFence(line);
    if (fence) {
      const body: string[] = [line];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        body.push(current);
        index += 1;
        if (isClosingFence(current, fence)) {
          break;
        }
      }
      blocks.push({ kind: 'code', lines: body, fence });
      continue;
    }
    if (isTableStart(lines, index)) {
      const body: string[] = [];
      while (index < lines.length && looksLikeTableRow(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'table', lines: body });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || openingFence(current) || isTableStart(lines, index)) {
        break;
      }
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: 'text', lines: body });
  }
  return blocks;
}

/** 按码点硬切，避免把代理对（emoji 等）切成半个字符。 */
function splitByLength(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) {
    return [line];
  }
  const parts: string[] = [];
  let buffer: string[] = [];
  let size = 0;
  for (const point of Array.from(line)) {
    if (size > 0 && size + point.length > maxLength) {
      parts.push(buffer.join(''));
      buffer = [];
      size = 0;
    }
    buffer.push(point);
    size += point.length;
  }
  if (buffer.length > 0) {
    parts.push(buffer.join(''));
  }
  return parts;
}

/** 把超长的普通文本块拆成每段都不超过 `maxLength` 的片段。 */
function splitTextBlock(lines: readonly string[], maxLength: number): string[] {
  const pieces: string[] = [];
  let buffer: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }
    pieces.push(buffer.join('\n'));
    buffer = [];
    size = 0;
  };
  for (const line of lines) {
    for (const part of splitByLength(line, maxLength)) {
      if (size > 0 && size + part.length + 1 > maxLength) {
        flush();
      }
      buffer.push(part);
      size = buffer.length === 1 ? part.length : size + part.length + 1;
    }
  }
  flush();
  return pieces;
}

/** 拆分超长代码块：每段都带完整的开启与闭合围栏。 */
function splitCodeBlock(block: { lines: readonly string[]; fence: Fence }, maxLength: number): string[] {
  const open = `${block.fence.marker}${block.fence.info}`;
  const close = block.fence.marker;
  const last = block.lines[block.lines.length - 1] ?? '';
  const hasClosing = isClosingFence(last, block.fence);
  const body = block.lines.slice(1, hasClosing ? block.lines.length - 1 : undefined);
  const overhead = open.length + close.length + 2;
  if (overhead >= maxLength) {
    // 围栏本身就把额度吃光了（畸形输入），退化为按行切，不再保证围栏完整。
    return splitTextBlock(block.lines, maxLength);
  }
  const budget = maxLength - overhead;
  const pieces: string[] = [];
  let buffer: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }
    pieces.push(`${open}\n${buffer.join('\n')}\n${close}`);
    buffer = [];
    size = 0;
  };
  for (const line of body) {
    for (const part of splitByLength(line, budget)) {
      if (size > 0 && size + part.length + 1 > budget) {
        flush();
      }
      buffer.push(part);
      size = buffer.length === 1 ? part.length : size + part.length + 1;
    }
  }
  flush();
  return pieces.length > 0 ? pieces : [`${open}\n${close}`];
}

/** 拆分超长表格：每段重复表头与分隔行，保持列语义。 */
function splitTableBlock(lines: readonly string[], maxLength: number): string[] {
  const header = lines[0] ?? '';
  const separator = lines[1] ?? '';
  const prefix = `${header}\n${separator}`;
  if (prefix.length + 1 >= maxLength) {
    return splitTextBlock(lines, maxLength);
  }
  const budget = maxLength - prefix.length - 1;
  const pieces: string[] = [];
  let buffer: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }
    pieces.push(`${prefix}\n${buffer.join('\n')}`);
    buffer = [];
    size = 0;
  };
  for (const row of lines.slice(2)) {
    for (const part of splitByLength(row, budget)) {
      if (size > 0 && size + part.length + 1 > budget) {
        flush();
      }
      buffer.push(part);
      size = buffer.length === 1 ? part.length : size + part.length + 1;
    }
  }
  flush();
  return pieces.length > 0 ? pieces : [prefix];
}

/**
 * 切分消息。
 *
 * 返回的每一段都满足 `length <= maxLength`；空输入返回空数组。
 */
export function splitMessage(content: string, options: ChunkOptions = {}): string[] {
  const maxLength = options.maxLength ?? DEFAULT_CHUNK_LENGTH;
  if (!Number.isInteger(maxLength) || maxLength < MIN_MAX_LENGTH) {
    throw new RangeError(`maxLength 必须是不小于 ${MIN_MAX_LENGTH} 的整数`);
  }
  const text = normalize(content);
  if (text === '') {
    return [];
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const value = current.join('\n');
    if (value !== '') {
      chunks.push(value);
    }
    current = [];
    currentLength = 0;
  };

  /** 尝试把一段整体放进当前分片；放不下就先收尾。 */
  const append = (value: string): void => {
    if (value === '') {
      return;
    }
    const extra = current.length === 0 ? value.length : value.length + 1;
    if (current.length > 0 && currentLength + extra > maxLength) {
      flush();
    }
    current.push(value);
    currentLength = current.length === 1 ? value.length : currentLength + extra;
  };

  for (const block of parseBlocks(text.split('\n'))) {
    const rendered = block.lines.join('\n');
    if (block.kind === 'code') {
      if (rendered.length <= maxLength) {
        append(rendered);
        continue;
      }
      flush();
      for (const piece of splitCodeBlock(block, maxLength)) {
        chunks.push(piece);
      }
      continue;
    }
    if (block.kind === 'table') {
      if (rendered.length <= maxLength) {
        append(rendered);
        continue;
      }
      flush();
      for (const piece of splitTableBlock(block.lines, maxLength)) {
        chunks.push(piece);
      }
      continue;
    }
    if (rendered.length <= maxLength) {
      append(rendered);
      continue;
    }
    for (const piece of splitTextBlock(block.lines, maxLength)) {
      append(piece);
    }
  }
  flush();
  return chunks;
}
