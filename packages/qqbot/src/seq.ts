/**
 * `msg_seq` 序号器。
 *
 * QQ 平台要求同一 `msg_id` 的多次回复携带单调自增的 `msg_seq`；SDK 1.0.5 用的是
 * `时间戳 ^ 随机数` 的公式，既可能重复也可能倒退，平台会以 40054005 之类的错误拒绝。
 * 这里改为按 `msg_id` 维护计数器：从 1 开始，每次 +1，并带 TTL 与容量上限。
 *
 * 纯内存实现：进程重启后序号从 1 重新开始。这符合平台语义——`msg_id` 的回复窗口
 * 只有几分钟，重启后旧 `msg_id` 早已失效。
 */

export interface MessageSequenceOptions {
  /** 计数器空闲多久后回收，默认 10 分钟（覆盖平台回复窗口）。 */
  readonly ttlMs?: number;
  /** 最多保留多少个 `msg_id`，默认 4096。 */
  readonly maxEntries?: number;
  /** 时间源，测试可注入。 */
  readonly now?: () => number;
}

interface Entry {
  value: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

export class MessageSequence {
  private readonly entries = new Map<string, Entry>();

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  constructor(options: MessageSequenceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 取下一个序号。
   *
   * 首次调用返回 1；在 TTL 内继续调用递增；过期后重新从 1 开始。
   */
  next(key: string): number {
    this.prune();
    const current = this.now();
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { value: 1, expiresAt: current + this.ttlMs });
      this.enforceCapacity();
      return 1;
    }
    existing.value += 1;
    existing.expiresAt = current + this.ttlMs;
    return existing.value;
  }

  /** 丢弃某个 `msg_id` 的计数器，例如消息已被平台判定过期。 */
  forget(key: string): boolean {
    return this.entries.delete(key);
  }

  /** 清理过期条目，返回清理数量。 */
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

  /** 当前保留的计数器数量（含尚未清理的过期项）。 */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** 容量超限时按插入顺序淘汰最旧的键：Map 保证先进先出。 */
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
