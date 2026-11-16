/**
 * 平台错误识别与发送失败的统一错误类型。
 *
 * QQ 开放平台的错误是「HTTP 状态 + 业务码」两层结构，业务码才是分支依据。
 * SDK 把它们放在 `ApiError.bizCode` / `httpStatus` 上；这里用结构化鸭子类型读取，
 * 不依赖 SDK 的类身份（打包后可能出现两份模块副本）。
 */

/** 没有 Markdown 权限时平台返回的业务码。 */
export const MARKDOWN_PERMISSION_CODES: readonly number[] = [304036, 304014, 50056];

/** 从任意错误对象上尽量取出的平台信息。 */
export interface PlatformErrorInfo {
  /** 业务错误码，例如 22009 / 304036 / 40054005。 */
  readonly code: number | undefined;
  /** HTTP 状态码。 */
  readonly httpStatus: number | undefined;
  readonly message: string;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

/** 读取平台错误码、HTTP 状态与消息。非对象错误退化为字符串消息。 */
export function platformErrorInfo(error: unknown): PlatformErrorInfo {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, httpStatus: undefined, message: String(error) };
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : String(error);
  return {
    code: readNumber(record, 'bizCode') ?? readNumber(record, 'code'),
    httpStatus: readNumber(record, 'httpStatus') ?? readNumber(record, 'status'),
    message,
  };
}

/**
 * 是否为「没有 Markdown 权限」。
 *
 * 只在业务码命中时返回 true；不按消息文本猜测，避免把其他权限错误误判成可降级。
 */
export function isMarkdownPermissionError(error: unknown): boolean {
  const { code } = platformErrorInfo(error);
  return code !== undefined && MARKDOWN_PERMISSION_CODES.includes(code);
}

/** 发送失败的统一错误：保留平台码，消息文本只给稳定描述。 */
export class GatewaySendError extends Error {
  readonly code: number | undefined;

  readonly httpStatus: number | undefined;

  constructor(info: PlatformErrorInfo) {
    const suffix = info.code === undefined ? '' : ` (code=${info.code})`;
    super(`QQ 消息发送失败${suffix}: ${info.message}`);
    this.name = 'GatewaySendError';
    this.code = info.code;
    this.httpStatus = info.httpStatus;
  }
}
