/**
 * `@gt6ce/qqbot` 公共入口。
 *
 * 只导出本包自己的协议类型与实现：任何 `@tencent-connect/qqbot-nodejs` 的类型
 * 都不出现在这里，上层应用因此不会与 SDK 的具体版本耦合。
 */
export { splitMessage, type ChunkOptions } from './chunker.ts';
export {
  GatewaySendError,
  MARKDOWN_PERMISSION_CODES,
  isMarkdownPermissionError,
  platformErrorInfo,
  type PlatformErrorInfo,
} from './errors.ts';
export {
  FATAL_CLOSE_CODES,
  QQBotGateway,
  createGateway,
  isFatalCloseCode,
  type GatewayOptions,
} from './gateway.ts';
export { MessageSequence, type MessageSequenceOptions } from './seq.ts';
export type {
  ChatScope,
  FatalDisconnect,
  GatewayConfig,
  InboundAttachment,
  InboundMention,
  InboundMessage,
  QQGateway,
  ReplyOptions,
  ReplyResult,
  ReplyTarget,
  Transport,
  TransportHandlers,
  TransportSendRequest,
  TransportSendResult,
} from './types.ts';
export { DEFAULT_CHUNK_LENGTH } from './types.ts';

export const PACKAGE_NAME = '@gt6ce/qqbot';
