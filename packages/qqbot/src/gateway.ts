/**
 * QQ 网关封装。
 *
 * 这一层负责四件事，且只负责这四件事：
 *
 * 1. 把 `@tencent-connect/qqbot-nodejs` 的 WebSocket 客户端藏在 {@link SdkTransport} 里，
 *    对上只暴露本包的 {@link QQGateway} 接口；
 * 2. 收到不可恢复的关闭码时主动停止重连，并通知上层退出（避免反复 Identify 耗尽配额）；
 * 3. 发送前按 Markdown 结构切分，逐段取单调递增的 `msg_seq`；
 * 4. 平台拒绝 Markdown 时降级为纯文本重发一次，并把错误码与上下文写进结构化日志。
 *    平台错误码按业务码区分：22009（内容超长）、40054005（`msg_seq` 非法）、
 *    40034128（频率或权限限制）等都原样记录，不做文本猜测。
 *
 * 模块顶层不读 `process.env`：`appId` / `appSecret` / `stateDir` 都由构造参数传入。
 */
import {
  FileKVStore,
  MsgType,
  QQBot,
  kvSessionPersistence,
} from '@tencent-connect/qqbot-nodejs';
import type {
  GatewayDisconnect,
  Logger as SdkLogger,
  QQBotInboundMessage,
} from '@tencent-connect/qqbot-nodejs';
import { createLogger, type Logger } from '@gt6ce/shared';

import { splitMessage } from './chunker.ts';
import {
  GatewaySendError,
  isMarkdownPermissionError,
  platformErrorInfo,
} from './errors.ts';
import { MessageSequence } from './seq.ts';
import {
  DEFAULT_CHUNK_LENGTH,
  type FatalDisconnect,
  type GatewayConfig,
  type InboundAttachment,
  type InboundMention,
  type InboundMessage,
  type QQGateway,
  type ReplyOptions,
  type ReplyResult,
  type ReplyTarget,
  type Transport,
  type TransportHandlers,
  type TransportSendRequest,
  type TransportSendResult,
} from './types.ts';

/**
 * 不可恢复的关闭码。
 *
 * 这些关闭码表示凭据、权限或分片参数本身有问题：继续重连只会重复 Identify，
 * 既不会成功，也会消耗平台配额。命中即停机，交给运维修正配置。
 */
export const FATAL_CLOSE_CODES: readonly number[] = [4001, 4002, 4010, 4011, 4012, 4013, 4014];

export function isFatalCloseCode(code: number): boolean {
  return FATAL_CLOSE_CODES.includes(code);
}

function toAttachments(message: QQBotInboundMessage): InboundAttachment[] {
  return (message.attachments ?? []).map((attachment) => ({
    contentType: attachment.content_type,
    url: attachment.url,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.size ? { size: attachment.size } : {}),
  }));
}

function toMentions(message: QQBotInboundMessage): InboundMention[] {
  return (message.mentions ?? []).map((mention) => ({
    ...(mention.user_openid ?? mention.member_openid ?? mention.id
      ? { userId: mention.user_openid ?? mention.member_openid ?? mention.id }
      : {}),
    ...(mention.nickname ?? mention.username
      ? { name: mention.nickname ?? mention.username }
      : {}),
    ...(typeof mention.bot === 'boolean' ? { isBot: mention.bot } : {}),
    isSelf: mention.is_you === true,
  }));
}

/**
 * SDK 消息 → 本包消息。
 *
 * 频道（guild）与频道私信（dm）不在首版范围，返回 `undefined` 由调用方忽略。
 */
export function normalizeInboundMessage(message: QQBotInboundMessage): InboundMessage | undefined {
  if (message.kind !== 'group' && message.kind !== 'c2c') {
    return undefined;
  }
  const kind = message.kind;
  const targetId = kind === 'group' ? (message.groupOpenid ?? '') : message.senderId;
  if (targetId === '') {
    return undefined;
  }
  return {
    id: message.messageId,
    scope: kind,
    scopeKey: `${kind}:${targetId}`,
    targetId,
    senderId: message.senderId,
    senderIsBot: message.senderIsBot === true,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    content: message.content ?? '',
    timestamp: message.timestamp,
    ...(message.refMsgIdx ? { quotedRefIndex: message.refMsgIdx } : {}),
    attachments: toAttachments(message),
    mentions: toMentions(message),
  };
}

function sdkLogger(logger: Logger): SdkLogger {
  return {
    info: (message, meta) => logger.debug(`[sdk] ${message}`, meta ?? {}),
    warn: (message, meta) => logger.warn(`[sdk] ${message}`, meta ?? {}),
    error: (message, meta) => logger.error(`[sdk] ${message}`, meta ?? {}),
    debug: (message, meta) => logger.debug(`[sdk] ${message}`, meta ?? {}),
  };
}

/**
 * 默认传输层：`@tencent-connect/qqbot-nodejs` 的 WebSocket 客户端。
 *
 * 传入 `stateDir` 时用 `FileKVStore` + `kvSessionPersistence` 持久化 session id 与
 * last seq，进程重启后可走 RESUME 而不是重新 Identify。SDK 1.0.5 里没有名为
 * `FileSessionStore` 的导出，`FileKVStore` 就是它的文件后端。
 */
export class SdkTransport implements Transport {
  private readonly bot: QQBot;

  private readonly store: FileKVStore | undefined;

  constructor(config: GatewayConfig, logger: Logger) {
    this.store = config.stateDir
      ? new FileKVStore({
          dir: config.stateDir,
          logger: { error: (message) => logger.error('会话持久化读写失败', { detail: message }) },
        })
      : undefined;
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      markdownSupport: config.markdownSupport,
      logger: sdkLogger(logger),
      ...(this.store
        ? { sessionPersistence: kvSessionPersistence({ store: this.store, accountId: config.appId }) }
        : {}),
    });
  }

  async start(handlers: TransportHandlers): Promise<void> {
    this.bot.on('message', async (_ctx, message) => {
      const normalized = normalizeInboundMessage(message);
      if (!normalized) {
        return;
      }
      await handlers.onMessage(normalized);
    });
    this.bot.on('disconnected', (event: GatewayDisconnect) => {
      handlers.onDisconnected({
        code: event.code,
        reason: event.reason,
        willReconnect: event.willReconnect,
      });
    });
    this.bot.on('error', (error: Error) => {
      handlers.onError(error);
    });
    // SDK 的 start() 在连接存活期间不会 resolve；生命周期由 stop() 结束。
    await this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }

  flush(): void {
    this.store?.flush();
  }

  async send(request: TransportSendRequest): Promise<TransportSendResult> {
    const response = await this.bot.send({
      target: {
        scope: request.scope,
        targetId: request.targetId,
        ...(request.msgId ? { msgId: request.msgId } : {}),
      },
      ...(request.markdown !== null
        ? { msgType: MsgType.MARKDOWN, markdown: { content: request.markdown } }
        : { msgType: MsgType.TEXT, content: request.text ?? '' }),
      ...(request.msgSeq !== undefined ? { extra: { msg_seq: request.msgSeq } } : {}),
    });
    return {
      messageId: response.id,
      ...(response.ext_info?.ref_idx ? { refIndex: response.ext_info.ref_idx } : {}),
    };
  }
}

export interface GatewayOptions {
  readonly config: GatewayConfig;
  readonly logger?: Logger;
  /** 测试注入的传输层；省略时使用 {@link SdkTransport}。 */
  readonly transport?: Transport;
  /** 序号器时钟，测试可注入。 */
  readonly now?: () => number;
  readonly sequence?: MessageSequence;
}

export class QQBotGateway implements QQGateway {
  private readonly config: GatewayConfig;

  private readonly logger: Logger;

  private readonly transport: Transport;

  private readonly sequence: MessageSequence;

  private readonly messageHandlers = new Set<(message: InboundMessage) => void | Promise<void>>();

  private readonly fatalHandlers = new Set<(event: FatalDisconnect) => void>();

  private readonly errorHandlers = new Set<(error: Error) => void>();

  private started = false;

  private stopped = false;

  private fatalEmitted = false;

  private running: Promise<void> = Promise.resolve();

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger({ scope: 'qqbot.gateway' });
    this.transport = options.transport ?? new SdkTransport(options.config, this.logger);
    this.sequence = options.sequence ?? new MessageSequence(options.now ? { now: options.now } : {});
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    this.fatalEmitted = false;
    this.logger.info('QQ 网关启动', {
      appId: this.config.appId,
      sandbox: this.config.sandbox,
      markdownSupport: this.config.markdownSupport,
      stateDir: this.config.stateDir ?? '(memory)',
    });
    const running = this.transport.start({
      onMessage: (message) => this.dispatchMessage(message),
      onDisconnected: (event) => this.handleDisconnect(event),
      onError: (error) => this.emitError(error),
    });
    this.running = running.then(
      () => undefined,
      (error: unknown) => {
        this.handleStartFailure(error);
      },
    );
    // 长连接不会在 start() 内结束：连接失败通过 onFatal / onError 上报。
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    try {
      this.transport.stop();
    } catch (error) {
      this.logger.warn('停止传输层时抛错', { error });
    }
    try {
      this.transport.flush?.();
    } catch (error) {
      this.logger.warn('落盘会话时抛错', { error });
    }
    this.sequence.clear();
    await this.running;
    this.started = false;
    this.logger.info('QQ 网关已停止', { appId: this.config.appId });
  }

  async reply(target: ReplyTarget, content: string, options: ReplyOptions = {}): Promise<ReplyResult> {
    const chunkLength = options.chunkLength ?? this.config.chunkLength ?? DEFAULT_CHUNK_LENGTH;
    const chunks = splitMessage(content, { maxLength: chunkLength });
    if (chunks.length === 0) {
      return { messageIds: [], refIndexes: [], chunks: 0, degraded: false };
    }
    const messageIds: string[] = [];
    const refIndexes: (string | undefined)[] = [];
    let markdown = options.markdown ?? this.config.markdownSupport;
    let degraded = false;
    const seqKey = target.msgId;

    for (const [index, chunk] of chunks.entries()) {
      const seq = seqKey ? this.sequence.next(seqKey) : undefined;
      try {
        const result = await this.sendChunk(target, chunk, markdown, seq);
        messageIds.push(result.messageId);
        refIndexes.push(result.refIndex);
      } catch (error) {
        if (!markdown || !isMarkdownPermissionError(error)) {
          throw error instanceof GatewaySendError ? error : new GatewaySendError(platformErrorInfo(error));
        }
        const info = platformErrorInfo(error);
        this.logger.warn('缺少 Markdown 权限，降级为纯文本重发', {
          code: info.code,
          msgId: target.msgId,
          chunk: index,
          chunks: chunks.length,
        });
        markdown = false;
        degraded = true;
        const retrySeq = seqKey ? this.sequence.next(seqKey) : undefined;
        const retry = await this.sendChunk(target, chunk, false, retrySeq);
        messageIds.push(retry.messageId);
        refIndexes.push(retry.refIndex);
      }
    }
    return { messageIds, refIndexes, chunks: chunks.length, degraded };
  }

  onMessage(handler: (message: InboundMessage) => void | Promise<void>): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onFatal(handler: (event: FatalDisconnect) => void): () => void {
    this.fatalHandlers.add(handler);
    return () => {
      this.fatalHandlers.delete(handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  private async sendChunk(
    target: ReplyTarget,
    text: string,
    markdown: boolean,
    msgSeq: number | undefined,
  ): Promise<TransportSendResult> {
    try {
      return await this.transport.send({
        scope: target.scope,
        targetId: target.targetId,
        ...(target.msgId ? { msgId: target.msgId } : {}),
        ...(msgSeq !== undefined ? { msgSeq } : {}),
        markdown: markdown ? text : null,
        text: markdown ? null : text,
      });
    } catch (error) {
      const info = platformErrorInfo(error);
      this.logger.error('QQ 消息发送失败', {
        code: info.code,
        httpStatus: info.httpStatus,
        detail: info.message,
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId,
        msgSeq,
        markdown,
        length: text.length,
      });
      throw error;
    }
  }

  private handleDisconnect(event: FatalDisconnect & { readonly willReconnect: boolean }): void {
    if (isFatalCloseCode(event.code)) {
      this.logger.error('网关不可恢复关闭，主动停止重连', {
        code: event.code,
        reason: event.reason,
      });
      try {
        this.transport.stop();
      } catch (error) {
        this.logger.warn('停止传输层时抛错', { error });
      }
      this.emitFatal({ code: event.code, reason: event.reason });
      return;
    }
    if (event.willReconnect) {
      this.logger.warn('网关断开，SDK 将自动重连', {
        code: event.code,
        reason: event.reason,
      });
      return;
    }
    this.logger.error('网关断开且不会重连', { code: event.code, reason: event.reason });
    this.emitFatal({ code: event.code, reason: event.reason });
  }

  private handleStartFailure(error: unknown): void {
    if (this.stopped) {
      return;
    }
    const info = platformErrorInfo(error);
    const closeCode = readCloseCode(error);
    this.logger.error('网关启动失败', {
      code: info.code,
      httpStatus: info.httpStatus,
      closeCode,
      detail: info.message,
    });
    this.emitFatal({
      code: closeCode ?? info.code ?? 0,
      reason: info.message,
    });
  }

  private async dispatchMessage(message: InboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        this.logger.error('消息处理器抛错', { messageId: message.id, error });
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private emitFatal(event: FatalDisconnect): void {
    if (this.fatalEmitted) {
      return;
    }
    this.fatalEmitted = true;
    for (const handler of this.fatalHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('fatal 处理器抛错', { error });
      }
    }
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (nested) {
        this.logger.error('error 处理器抛错', { error: nested });
      }
    }
  }
}

function readCloseCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value = (error as { closeCode?: unknown }).closeCode;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 便捷构造器。 */
export function createGateway(options: GatewayOptions): QQGateway {
  return new QQBotGateway(options);
}
