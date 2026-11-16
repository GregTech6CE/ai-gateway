/**
 * `@gt6ce/qqbot` 的对外契约。
 *
 * 这里定义的是本仓库自己的协议，**不暴露** `@tencent-connect/qqbot-nodejs` 的任何
 * 类型：SDK 升级、换版本甚至日后替换为裸 `ws` + `fetch` 实现时，`apps/qqbot` 不需要
 * 跟着改。所有 SDK 类型转换都收敛在 `gateway.ts` 的 `SdkTransport` 里。
 */

/** 会话类型。频道（guild）与频道私信（dm）不在首版范围内。 */
export type ChatScope = 'c2c' | 'group';

/** 入站消息携带的附件。字段名与平台语义对齐，但类型由本包定义。 */
export interface InboundAttachment {
  readonly contentType: string;
  readonly url: string;
  readonly filename?: string;
  readonly size?: number;
}

/** 入站消息里的 @ 提及。 */
export interface InboundMention {
  readonly userId?: string;
  readonly name?: string;
  readonly isBot?: boolean;
  /** 是否 @ 了机器人自己。 */
  readonly isSelf: boolean;
}

/** 归一化后的入站消息。 */
export interface InboundMessage {
  /** 平台消息 id，也是去重的唯一键。 */
  readonly id: string;
  readonly scope: ChatScope;
  /** 规范化会话键：`group:<group_openid>` 或 `c2c:<user_openid>`。 */
  readonly scopeKey: string;
  /** 会话目标 id：群 openid 或用户 openid。 */
  readonly targetId: string;
  readonly senderId: string;
  readonly senderName?: string;
  /** 发送者是否为机器人；上层用它避免自问自答式的循环。 */
  readonly senderIsBot: boolean;
  readonly content: string;
  readonly timestamp: string;
  /**
   * 被引用消息的 ref_idx。
   *
   * QQ 平台不直接给出被引用消息的 id，只给引用序号；发送消息时平台会在
   * `ext_info.ref_idx` 返回可被引用的序号，因此上层用这个值把「引用回复」
   * 接回之前的机器人提问。
   */
  readonly quotedRefIndex?: string;
  readonly attachments: readonly InboundAttachment[];
  readonly mentions: readonly InboundMention[];
}

/** 回复目标。带 `msgId` 时是回复，不带时是主动推送。 */
export interface ReplyTarget {
  readonly scope: ChatScope;
  readonly targetId: string;
  readonly msgId?: string;
}

export interface ReplyOptions {
  /** 是否按 Markdown 发送；省略时取网关配置的 `markdownSupport`。 */
  readonly markdown?: boolean;
  /** 单条 Markdown 上限，默认 {@link DEFAULT_CHUNK_LENGTH}。 */
  readonly chunkLength?: number;
}

export interface ReplyResult {
  readonly messageIds: readonly string[];
  /** 平台返回的引用序号；平台未返回时为 `undefined`。 */
  readonly refIndexes: readonly (string | undefined)[];
  readonly chunks: number;
  /** 是否因为缺少 Markdown 权限而整条降级为纯文本。 */
  readonly degraded: boolean;
}

/** 网关运行配置。所有字段由调用方显式传入，不在模块顶层读 `process.env`。 */
export interface GatewayConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** 沙箱环境标记，仅用于日志与运维提示；SDK 侧无需区分。 */
  readonly sandbox: boolean;
  /** 会话持久化目录；省略则不落盘（仅内存）。 */
  readonly stateDir?: string;
  /** 机器人是否具备 Markdown 权限；没有时首条即按纯文本发送。 */
  readonly markdownSupport: boolean;
  /** 单条消息上限，默认 4500。 */
  readonly chunkLength?: number;
}

/** 不可恢复的关闭事件。 */
export interface FatalDisconnect {
  readonly code: number;
  readonly reason: string;
}

/**
 * 上层使用的网关门面。
 *
 * 只暴露「发消息」与「收消息」两件事：连接、重连、序号、切分、降级、
 * 错误码记录都在实现内部完成。
 */
export interface QQGateway {
  /** 启动连接。不等待长连接建立，连接失败通过 `onFatal` / `onError` 上报。 */
  start(): Promise<void>;
  /** 停止连接并落盘会话。可重复调用。 */
  stop(): Promise<void>;
  reply(target: ReplyTarget, content: string, options?: ReplyOptions): Promise<ReplyResult>;
  /** 订阅入站消息；返回取消订阅函数。 */
  onMessage(handler: (message: InboundMessage) => void | Promise<void>): () => void;
  /** 订阅不可恢复关闭；返回取消订阅函数。 */
  onFatal(handler: (event: FatalDisconnect) => void): () => void;
  /** 订阅非致命错误；返回取消订阅函数。 */
  onError(handler: (error: Error) => void): () => void;
}

/** 默认单条消息上限。QQ 群消息上限约 5000 字，留出安全余量。 */
export const DEFAULT_CHUNK_LENGTH = 4500;

/** 传输层请求：`markdown` 与 `text` 二选一。 */
export interface TransportSendRequest {
  readonly scope: ChatScope;
  readonly targetId: string;
  readonly msgId?: string;
  /** `msg_seq`；无 `msgId`（主动推送）时为 `undefined`，交给平台默认值。 */
  readonly msgSeq?: number;
  readonly markdown: string | null;
  readonly text: string | null;
}

export interface TransportSendResult {
  readonly messageId: string;
  readonly refIndex?: string;
}

/** 传输层回调。实现方负责把平台事件翻译成这些回调。 */
export interface TransportHandlers {
  readonly onMessage: (message: InboundMessage) => void | Promise<void>;
  readonly onDisconnected: (event: FatalDisconnect & { readonly willReconnect: boolean }) => void;
  readonly onError: (error: Error) => void;
}

/**
 * 传输层抽象。
 *
 * 只有 `gateway.ts` 使用它；测试没有 WebSocket 也能覆盖发送、切分、
 * 降级与关闭码处理。默认实现是 `SdkTransport`。
 */
export interface Transport {
  start(handlers: TransportHandlers): Promise<void>;
  stop(): void;
  send(request: TransportSendRequest): Promise<TransportSendResult>;
  /** 落盘待写入的持久化数据（若有）。 */
  flush?(): void;
}
