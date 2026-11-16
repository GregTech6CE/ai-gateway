/**
 * 内部 HTTP 服务端的公共设施。
 *
 * `apps/agent-svc` 与 `apps/github-svc` 都用 `node:http` 直接实现，不引框架。两个服务
 * 需要的鉴权、请求体读取与 JSON 响应完全一致，放在这里可以避免安全关键逻辑各写一份。
 *
 * 约定：
 * - token 比对先做 SHA-256 再 `timingSafeEqual`，长度不同也不会提前返回；
 * - 请求体有硬上限，超限返回 413，不把整个 body 读进内存再判断；
 * - 错误响应只含稳定文案与错误码，不含堆栈或请求内容。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 服务端可预期的失败；`status` 直接作为响应码，`message` 可安全回给调用方。 */
export class HttpError extends Error {
  readonly status: number;

  readonly code: string;

  constructor(status: number, message: string, code = 'http_error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** 默认请求体上限：服务的 JSON 负载都很小，1 MiB 已足够。 */
export const DEFAULT_MAX_BODY_BYTES = 1_024 * 1_024;

/**
 * 常量时间 token 比对。
 *
 * 直接比较字符串会在首个不同字符处返回，泄露前缀信息；长度不同时 `timingSafeEqual`
 * 还会抛错。这里先各自做 SHA-256，再比较等长摘要，两个问题一起解决。
 */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || expected === '') {
    return false;
  }
  const left = createHash('sha256').update(provided, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** 从 `Authorization` 头取出 Bearer token；格式不符返回 `undefined`。 */
export function bearerToken(header: string | readonly string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? undefined : token;
}

export interface ReadJsonOptions {
  /** 请求体字节上限，默认 {@link DEFAULT_MAX_BODY_BYTES}。 */
  readonly maxBytes?: number;
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 边读边计数，超限立即抛 413 并停止累积；空体与非法 JSON 都是 400。
 */
export async function readJsonBody(
  request: IncomingMessage,
  options: ReadJsonOptions = {},
): Promise<unknown> {
  const limit = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = toBuffer(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(413, '请求体超过上限', 'payload_too_large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') {
    throw new HttpError(400, '请求体为空', 'invalid_body');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON', 'invalid_body');
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk));
}

/** 写一条 JSON 响应；统一 `no-store`，内部服务的响应不需要缓存。 */
export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
}

/** 写一条错误响应。`message` 必须是稳定文案，不得拼接内部错误详情。 */
export function writeError(
  response: ServerResponse,
  status: number,
  message: string,
  code = 'http_error',
): void {
  writeJson(response, status, { error: message, code });
}

/** 405 响应，附带 `Allow` 头。 */
export function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader('allow', allowed.join(', '));
  writeError(response, 405, '方法不允许', 'method_not_allowed');
}

/** 解析请求 URL；`node:http` 只给相对路径，这里补一个占位 origin。 */
export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost');
}
