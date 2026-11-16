/**
 * 命令路由。
 *
 * 路由器只做四件事：去重、找绑定、判权限、把请求交给注册表里的 Handler。
 * 业务细节全部在 Handler 里，后续加命令不需要改这个文件。
 */
import type { InboundMessage, ReplyOptions, ReplyResult, ReplyTarget } from '@gt6ce/qqbot';
import type { Logger } from '@gt6ce/shared';

import type { Binding } from './config.ts';
import { HELP_COMMAND } from './handlers/help.ts';
import { ISSUE_COMMAND, ISSUE_CONTINUATION } from './handlers/issue.ts';
import { HandlerRegistry } from './handlers/registry.ts';
import type {
  CommandContext,
  CommandRegistration,
  ContinuationContext,
  IssueServices,
} from './handlers/types.ts';
import { MessageDedupe, SessionStore, refKey, type Session } from './stores.ts';

/** 路由器只需要「能发消息」，不依赖网关的其余能力。 */
export interface Replier {
  reply(target: ReplyTarget, content: string, options?: ReplyOptions): Promise<ReplyResult>;
}

export type DispatchAction =
  | 'duplicate'
  | 'ignored'
  | 'unbound'
  | 'unknown-command'
  | 'command-not-allowed'
  | 'forbidden'
  | 'handled'
  | 'continued'
  | 'no-continuation';

export interface DispatchOutcome {
  readonly action: DispatchAction;
  readonly command?: string;
  readonly sessionId?: string;
  readonly detail?: string;
}

export interface ParsedCommand {
  readonly name: string;
  readonly args: string;
}

/**
 * 只认行首的斜杠命令；全角斜杠也接受（移动端输入法常驻全角）。
 *
 * 命令名之后的整段都是参数——包括换行，因为 `/issue` 支持一次写全多行信息。
 */
const COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+([\s\S]*))?$/;

export function parseCommand(content: string): ParsedCommand | undefined {
  const normalized = content.trim().replace(/^／/, '/');
  const match = COMMAND_PATTERN.exec(normalized);
  if (!match) {
    return undefined;
  }
  const name = (match[1] ?? '').toLowerCase();
  if (name === '') {
    return undefined;
  }
  return { name, args: (match[2] ?? '').trim() };
}

const UNBOUND_HINT =
  '这个会话还没有绑定仓库，暂时不能执行命令。\n请联系管理员在 `bindings` 里加入本会话的 openid 与仓库。';

export interface RouterOptions {
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly replier: Replier;
  readonly services: IssueServices;
  readonly logger: Logger;
  readonly sessions?: SessionStore;
  readonly dedupe?: MessageDedupe;
  readonly registry?: HandlerRegistry;
  readonly sessionTtlMs?: number;
}

/** 首版注册表：`/help` 与 `/issue`，以及 `/issue` 的引用回复续接。 */
export function createDefaultRegistry(): HandlerRegistry {
  return new HandlerRegistry()
    .register(HELP_COMMAND)
    .register(ISSUE_COMMAND)
    .setContinuation(ISSUE_CONTINUATION);
}

export class CommandRouter {
  private readonly bindings: ReadonlyMap<string, Binding>;

  private readonly replier: Replier;

  private readonly services: IssueServices;

  private readonly logger: Logger;

  private readonly sessions: SessionStore;

  private readonly dedupe: MessageDedupe;

  private readonly registry: HandlerRegistry;

  private readonly pending = new Set<Promise<void>>();

  constructor(options: RouterOptions) {
    this.bindings = options.bindings;
    this.replier = options.replier;
    this.services = options.services;
    this.logger = options.logger;
    this.sessions =
      options.sessions ??
      new SessionStore(options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs });
    this.dedupe = options.dedupe ?? new MessageDedupe();
    this.registry = options.registry ?? createDefaultRegistry();
  }

  /** 处理一条入站消息。重复投递返回 `duplicate`，不产生任何副作用。 */
  async handle(message: InboundMessage): Promise<DispatchOutcome> {
    if (!this.dedupe.firstSeen(message.id)) {
      this.logger.debug('重复消息，已忽略', { messageId: message.id });
      return { action: 'duplicate' };
    }
    // 机器人自己的消息不参与路由：群里有多个机器人时避免互相触发。
    if (message.senderIsBot) {
      return { action: 'ignored', detail: 'bot-sender' };
    }

    const command = parseCommand(message.content);
    const binding = this.bindings.get(message.scopeKey);

    if (command) {
      return this.dispatchCommand(message, binding, command);
    }
    return this.dispatchContinuation(message, binding);
  }

  /** 等待所有后台任务（建 Issue 链路）结束，供测试与优雅停机使用。 */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private async dispatchCommand(
    message: InboundMessage,
    binding: Binding | undefined,
    command: ParsedCommand,
  ): Promise<DispatchOutcome> {
    if (!binding) {
      await this.replyTo(message, UNBOUND_HINT);
      return { action: 'unbound', command: command.name };
    }

    const registration = this.registry.get(command.name);
    if (!registration) {
      await this.replyTo(message, `没有 /${command.name} 这个命令。发送 /help 查看可用命令。`);
      return { action: 'unknown-command', command: command.name };
    }

    // `/help` 始终可用：它只读，且是发现其他命令的入口。
    const allowed =
      registration.name === 'help' ||
      binding.allowedCommands.some((name) => name === registration.name);
    if (!allowed) {
      await this.replyTo(message, `本会话未启用 /${command.name}。发送 /help 查看可用命令。`);
      return { action: 'command-not-allowed', command: command.name };
    }

    if (registration.requiresMaintainer && !binding.maintainers.includes(message.senderId)) {
      this.logger.warn('非维护者尝试写操作', {
        messageId: message.id,
        senderId: message.senderId,
        scope: message.scopeKey,
        command: command.name,
      });
      await this.replyTo(message, `抱歉，/${command.name} 仅限本会话维护者使用。`);
      return { action: 'forbidden', command: command.name };
    }

    this.logger.info('执行命令', {
      messageId: message.id,
      scope: message.scopeKey,
      command: command.name,
    });
    const outcome = await registration.handler(
      this.commandContext(message, binding, command.args, registration),
    );
    return {
      action: 'handled',
      command: command.name,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  private async dispatchContinuation(
    message: InboundMessage,
    binding: Binding | undefined,
  ): Promise<DispatchOutcome> {
    if (!binding || !message.quotedRefIndex) {
      return { action: 'ignored' };
    }
    const session = this.sessions.resolveKey(refKey(message.quotedRefIndex));
    if (!session) {
      return { action: 'ignored', detail: 'unknown-quote' };
    }
    if (session.scopeKey !== message.scopeKey) {
      this.logger.warn('跨会话引用，已忽略', {
        messageId: message.id,
        scope: message.scopeKey,
        sessionId: session.id,
      });
      return { action: 'ignored', detail: 'cross-scope' };
    }
    const handler = this.registry.continuation();
    if (!handler) {
      return { action: 'no-continuation', sessionId: session.id };
    }
    const outcome = await handler(this.continuationContext(message, binding, session));
    return {
      action: 'continued',
      sessionId: session.id,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  private commandContext(
    message: InboundMessage,
    binding: Binding,
    args: string,
    registration: CommandRegistration,
  ): CommandContext {
    return {
      message,
      binding,
      args,
      log: this.logger.child(`cmd.${registration.name}`),
      sessions: this.sessions,
      services: this.services,
      availableCommands: this.availableCommands(binding),
      reply: (text, options) => this.replyTo(message, text, options),
      bindSession: (sessionId, result) => {
        this.bindSession(sessionId, result);
      },
      runInBackground: (task) => {
        this.track(task);
      },
    };
  }

  private continuationContext(
    message: InboundMessage,
    binding: Binding,
    session: Session,
  ): ContinuationContext {
    return {
      message,
      binding,
      session,
      log: this.logger.child('cmd.issue.followup'),
      sessions: this.sessions,
      services: this.services,
      reply: (text, options) => this.replyTo(message, text, options),
      bindSession: (sessionId, result) => {
        this.bindSession(sessionId, result);
      },
      runInBackground: (task) => {
        this.track(task);
      },
    };
  }

  private availableCommands(binding: Binding): readonly CommandRegistration[] {
    return this.registry.list().filter(
      (command) =>
        command.name === 'help' ||
        binding.allowedCommands.some((name) => name === command.name),
    );
  }

  private async replyTo(
    message: InboundMessage,
    text: string,
    options?: ReplyOptions,
  ): Promise<ReplyResult> {
    return this.replier.reply(
      {
        scope: message.scope,
        targetId: message.targetId,
        msgId: message.id,
      },
      text,
      options,
    );
  }

  private bindSession(sessionId: string, result: ReplyResult): void {
    this.sessions.bind(sessionId, result);
    if (result.refIndexes.every((value) => value === undefined)) {
      this.logger.warn('平台未返回 ref_idx，引用回复可能无法关联会话', {
        sessionId,
        messageIds: result.messageIds,
      });
    }
  }

  private track(task: () => Promise<void>): void {
    const promise = task().catch((error: unknown) => {
      this.logger.error('后台任务失败', { error });
    });
    this.pending.add(promise);
    void promise.then(() => {
      this.pending.delete(promise);
    });
  }
}
