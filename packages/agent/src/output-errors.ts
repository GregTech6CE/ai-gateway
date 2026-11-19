/**
 * 结构化输出失败的识别与兜底解析。
 *
 * 背景：`Output.object({ schema })` 在 provider 不支持 JSON Schema 形式 `response_format`
 * 时不会报错——只发一条 `unsupported responseFormat` 警告，schema 静默失效。模型于是按
 * 自由文本作答，SDK 在解析阶段抛 `NoObjectGeneratedError`（cause 通常是 `JSONParseError`）。
 *
 * 这类错误**没有 HTTP 状态码**，如果直接交给 `toModelError` 会落到兜底分支变成
 * `ModelError('network')`，触发 60 秒退避重试并把健康入口冷却数小时。本模块把
 * 「请求成功但输出不符合契约」单独识别出来，让调用方快速失败或先尝试一次兜底解析。
 *
 * 识别优先用 `isInstance`，再退回 `name` 鸭子类型：打包成单个 chunk 后，`instanceof`
 * 可能因多份 SDK 实例而失效，而 `name` 由 SDK 在构造时写入，跨副本稳定。
 */
import { JSONParseError, NoObjectGeneratedError } from 'ai';

const NO_OBJECT_NAME = 'AI_NoObjectGeneratedError';
const JSON_PARSE_NAME = 'AI_JSONParseError';

interface ErrorLike {
  readonly name?: unknown;
  readonly text?: unknown;
  readonly cause?: unknown;
  readonly usage?: unknown;
  readonly finishReason?: unknown;
}

function asErrorLike(error: unknown): ErrorLike | undefined {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : undefined;
}

function nameOf(error: unknown): string {
  const name = asErrorLike(error)?.name;
  return typeof name === 'string' ? name : '';
}

function hasIsInstance(value: unknown): value is { isInstance: (error: unknown) => boolean } {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { isInstance?: unknown }).isInstance === 'function'
  );
}

/** 模型没有产出可解析的对象（JSON 解析失败或不符合 schema）。 */
export function isNoObjectGeneratedError(error: unknown): boolean {
  if (hasIsInstance(NoObjectGeneratedError) && NoObjectGeneratedError.isInstance(error)) {
    return true;
  }
  return nameOf(error) === NO_OBJECT_NAME;
}

/** 单独的 JSON 解析失败；通常作为 `NoObjectGeneratedError` 的 cause 出现。 */
export function isJsonParseError(error: unknown): boolean {
  if (hasIsInstance(JSONParseError) && JSONParseError.isInstance(error)) {
    return true;
  }
  return nameOf(error) === JSON_PARSE_NAME;
}

/** 结构化输出类失败（两者之一）。 */
export function isStructuredOutputError(error: unknown): boolean {
  return isNoObjectGeneratedError(error) || isJsonParseError(error);
}

/** 把任意错误收敛成一句可写进日志/失败评论的摘要，不含模型正文。 */
export function describeStructuredOutputFailure(error: unknown): string {
  const name = nameOf(error) || 'UnknownError';
  const cause = asErrorLike(error)?.cause;
  const causeName = nameOf(cause);
  return causeName && causeName !== name
    ? `模型输出无法解析为结构化结论（${name} / ${causeName}）`
    : `模型输出无法解析为结构化结论（${name}）`;
}

export interface StructuredOutputFailure {
  /** SDK 保留的模型原始文本；有值时可尝试兜底解析。 */
  readonly text?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number };
  readonly finishReason?: string;
}

/**
 * 取出兜底解析需要的信息；不是结构化输出错误时返回 `undefined`。
 *
 * 未知字段一律忽略：SDK 换版本时宁可少拿到信息，也不要因为形状变化把真实错误吞掉。
 */
export function structuredOutputFailure(error: unknown): StructuredOutputFailure | undefined {
  if (!isStructuredOutputError(error)) {
    return undefined;
  }
  const like = asErrorLike(error);
  const text = typeof like?.text === 'string' ? like.text : undefined;
  const usage =
    typeof like?.usage === 'object' && like.usage !== null
      ? (like.usage as StructuredOutputFailure['usage'])
      : undefined;
  const finishReason = typeof like?.finishReason === 'string' ? like.finishReason : undefined;
  return {
    ...(text !== undefined ? { text } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}

/** 从模型输出里抓第一个 JSON 对象；抓不到就返回 undefined。 */
export function extractJsonObject(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 只依赖 `safeParse` 的最小契约，避免把 zod 的输入/输出泛型（`.default()` 会让二者不同）
 * 带进本模块的类型签名。
 */
export interface SafeParser<T> {
  safeParse(input: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

/**
 * 兜底解析：模型把 JSON 包在说明文字或代码围栏里时，SDK 可能解析失败，但对象本身是
 * 合法的。这里用与 `classifyRelevance` 相同的策略再解析一次，并通过 schema 校验。
 */
export function recoverFromText<T>(text: string | undefined, schema: SafeParser<T>): T | undefined {
  if (!text) {
    return undefined;
  }
  const raw = extractJsonObject(text);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
