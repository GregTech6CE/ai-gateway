/**
 * Handler 契约。
 *
 * 命令 Handler 是普通函数，不依赖任何流程引擎：路由器负责去重、绑定、权限与
 * 发送，Handler 只做「读上下文 → 回复 → 记录会话」。新增命令只需实现
 * {@link CommandHandler} 并注册到 {@link HandlerRegistry}。
 */
import type { InboundMessage, ReplyOptions, ReplyResult } from '@gt6ce/qqbot';
import type { Logger } from '@gt6ce/shared';

import type { Binding } from '../config.ts';
import type { AgentGateway, IssueWriter } from '../rpc-clients.ts';
import type { Session, SessionStore } from '../stores.ts';

/** 写操作需要的两个后端服务与轮询参数。 */
export interface IssueServices {
  readonly agent: AgentGateway;
  readonly writer: IssueWriter;
  readonly pollIntervalMs: number;
  readonly taskTimeoutMs: number;
}

export type HandlerReplyOptions = ReplyOptions;

/** Handler 可用的回复与后台任务能力，由路由器注入。 */
export interface Responder {
  reply(text: string, options?: HandlerReplyOptions): Promise<ReplyResult>;
  /** 把刚发出的消息绑定到会话，供用户引用回复时接回。 */
  bindSession(sessionId: string, result: ReplyResult): void;
  /** 注册后台任务；路由器在 `whenIdle()` 时等待它们结束。 */
  runInBackground(task: () => Promise<void>): void;
}

export interface CommandContext extends Responder {
  readonly message: InboundMessage;
  readonly binding: Binding;
  /** 命令名之后的原始参数文本。 */
  readonly args: string;
  readonly log: Logger;
  readonly sessions: SessionStore;
  readonly services: IssueServices;
  /** 当前群启用的命令，供 `/help` 展示。 */
  readonly availableCommands: readonly CommandRegistration[];
}

export interface ContinuationContext extends Responder {
  readonly message: InboundMessage;
  readonly binding: Binding;
  readonly session: Session;
  readonly log: Logger;
  readonly sessions: SessionStore;
  readonly services: IssueServices;
}

export interface HandlerOutcome {
  readonly handled: boolean;
  /** 结构化说明，仅用于日志与测试断言，不发给用户。 */
  readonly detail?: string;
}

export type CommandHandler = (context: CommandContext) => Promise<HandlerOutcome>;

export type ContinuationHandler = (context: ContinuationContext) => Promise<HandlerOutcome>;

export interface CommandRegistration {
  readonly name: string;
  /** 是否需要触发者在 `maintainers` 名单内。 */
  readonly requiresMaintainer: boolean;
  readonly summary: string;
  readonly usage: string;
  readonly handler: CommandHandler;
}
