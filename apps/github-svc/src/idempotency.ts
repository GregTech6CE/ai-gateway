/**
 * `requestId` 幂等缓存。
 *
 * 只缓存「已成功创建」的结果：失败不写缓存，QQ 侧可以安全重试。TTL 与容量都有限，
 * 进程重启后缓存清空——重复请求最多再建一条 Issue，与「重试导致重复」相比这是可接受的
 * 退化，且 QQ 侧的重试窗口很短。
 */
import type { CreatedIssue } from './contracts.ts';

export interface IdempotencyCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
}

interface Entry {
  readonly issue: CreatedIssue;
  readonly expiresAt: number;
}

export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  constructor(options: IdempotencyCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? (() => Date.now());
  }

  get(requestId: string): CreatedIssue | undefined {
    this.prune();
    const entry = this.entries.get(requestId);
    if (!entry) {
      return undefined;
    }
    return entry.issue;
  }

  set(requestId: string, issue: CreatedIssue): void {
    this.entries.set(requestId, { issue, expiresAt: this.now() + this.ttlMs });
    this.enforceCapacity();
  }

  prune(): number {
    const current = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= current) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
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
