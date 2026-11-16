/**
 * 进程内的轻量状态：消息去重与群会话。
 *
 * 两件事都只需要「短时间记住」：平台重投的消息在几分钟内到达，引用回复也只在
 * 机器人提问后的会话窗口内发生。因此不引外部存储，只做带 TTL 与容量上限的 Map；
 * 进程重启后状态丢失是可以接受的——用户重新发一次 `/issue` 即可。
 *
 * 长期状态（会话 id、last seq）由 `@gt6ce/qqbot` 的 SDK 传输层落盘，不在这里。
 */
import { randomUUID } from 'node:crypto';

/** 群会话里收集的原始字段。`title` 必填，其余按顺序补齐。 */
export interface DraftFields {
  title: string;
  version?: string;
  steps?: string;
  expected?: string;
  actual?: string;
}

export type DraftField = keyof DraftFields;

export type SessionStatus = 'collecting' | 'submitted';

export interface Session {
  readonly id: string;
  readonly scopeKey: string;
  readonly repo: string;
  readonly requesterId: string;
  fields: DraftFields;
  status: SessionStatus;
  /** 当前正在等待用户回答的字段；为空表示已提交。 */
  askField?: DraftField;
  readonly createdAt: number;
  updatedAt: number;
  /** 机器人已发出的消息 id / 引用序号，用于把引用回复接回本会话。 */
  readonly keys: Set<string>;
}

export interface SessionStoreOptions {
  /** 会话空闲多久后回收，默认 30 分钟。 */
  readonly ttlMs?: number;
  /** 最多保留多少个会话，默认 1000。 */
  readonly maxSessions?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;

export const MESSAGE_KEY_PREFIX = 'm:';
export const REF_KEY_PREFIX = 'r:';

/** 机器人消息 id → 会话。 */
export function messageKey(messageId: string): string {
  return `${MESSAGE_KEY_PREFIX}${messageId}`;
}

/** 平台引用序号（`ext_info.ref_idx` / 入站 `refMsgIdx`）→ 会话。 */
export function refKey(refIndex: string): string {
  return `${REF_KEY_PREFIX}${refIndex}`;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  private readonly index = new Map<string, string>();

  private readonly ttlMs: number;

  private readonly maxSessions: number;

  private readonly now: () => number;

  private readonly idFactory: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  create(input: {
    readonly scopeKey: string;
    readonly repo: string;
    readonly requesterId: string;
    readonly fields: DraftFields;
  }): Session {
    this.prune();
    const current = this.now();
    const session: Session = {
      id: this.idFactory(),
      scopeKey: input.scopeKey,
      repo: input.repo,
      requesterId: input.requesterId,
      fields: input.fields,
      status: 'collecting',
      createdAt: current,
      updatedAt: current,
      keys: new Set<string>(),
    };
    this.sessions.set(session.id, session);
    this.enforceCapacity();
    return session;
  }

  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    if (this.isExpired(session)) {
      this.remove(session.id);
      return undefined;
    }
    return session;
  }

  /** 按机器人消息 id 或引用序号找回会话。 */
  resolveKey(key: string): Session | undefined {
    const sessionId = this.index.get(key);
    if (!sessionId) {
      return undefined;
    }
    const session = this.get(sessionId);
    if (!session) {
      this.index.delete(key);
      return undefined;
    }
    return session;
  }

  /** 把一次回复产生的消息 id 与引用序号绑定到会话。 */
  bind(sessionId: string, result: { messageIds: readonly string[]; refIndexes: readonly (string | undefined)[] }): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    result.messageIds.forEach((messageId, index) => {
      const key = messageKey(messageId);
      session.keys.add(key);
      this.index.set(key, sessionId);
      const refIndex = result.refIndexes[index];
      if (refIndex) {
        const ref = refKey(refIndex);
        session.keys.add(ref);
        this.index.set(ref, sessionId);
      }
    });
  }

  touch(session: Session): void {
    session.updatedAt = this.now();
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    for (const key of session.keys) {
      this.index.delete(key);
    }
    this.sessions.delete(sessionId);
  }

  /** 清理过期会话，返回清理数量。 */
  prune(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  private isExpired(session: Session): boolean {
    return session.updatedAt + this.ttlMs <= this.now();
  }

  private enforceCapacity(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.remove(oldest.value);
    }
  }
}

export interface MessageDedupeOptions {
  /** 去重窗口，默认 10 分钟。 */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

/**
 * 按平台消息 id 去重。
 *
 * QQ 在重连或网络抖动后会重投同一条消息；`firstSeen` 只在第一次返回 true，
 * 后续重复投递直接丢弃，避免同一条 `/issue` 建出两个 Issue。
 */
export class MessageDedupe {
  private readonly entries = new Map<string, number>();

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  constructor(options: MessageDedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /** 首次见到返回 true；TTL 内再次见到返回 false。 */
  firstSeen(messageId: string): boolean {
    this.prune();
    if (this.entries.has(messageId)) {
      return false;
    }
    this.entries.set(messageId, this.now() + this.ttlMs);
    this.enforceCapacity();
    return true;
  }

  prune(): number {
    const current = this.now();
    let removed = 0;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= current) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
