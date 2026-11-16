/**
 * 命令 / 回调注册表。
 *
 * 路由器只认这张表：命令名 → 处理函数，以及一个「引用回复」的续接处理函数。
 * 后续加「原版行为问答」「群内投票」「PR/RFC 提醒」时，新增 Handler 并注册即可，
 * 不需要改路由器。
 */
import type {
  CommandHandler,
  CommandRegistration,
  ContinuationHandler,
} from './types.ts';

export class HandlerRegistry {
  private readonly commands = new Map<string, CommandRegistration>();

  private continuationHandler: ContinuationHandler | undefined;

  /** 注册命令；重名视为编码错误，直接抛。 */
  register(registration: CommandRegistration): this {
    if (this.commands.has(registration.name)) {
      throw new Error(`命令重复注册: ${registration.name}`);
    }
    this.commands.set(registration.name, registration);
    return this;
  }

  registerAll(registrations: readonly CommandRegistration[]): this {
    for (const registration of registrations) {
      this.register(registration);
    }
    return this;
  }

  get(name: string): CommandRegistration | undefined {
    return this.commands.get(name);
  }

  list(): readonly CommandRegistration[] {
    return [...this.commands.values()];
  }

  /** 设置引用回复的续接处理函数。 */
  setContinuation(handler: ContinuationHandler): this {
    this.continuationHandler = handler;
    return this;
  }

  continuation(): ContinuationHandler | undefined {
    return this.continuationHandler;
  }
}

export type { CommandHandler, CommandRegistration, ContinuationHandler };
