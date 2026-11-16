import { describe, expect, it } from 'vitest';

import { MessageSequence } from '../src/seq.ts';

describe('MessageSequence', () => {
  it('同一 msg_id 从 1 开始单调自增', () => {
    const seq = new MessageSequence({ now: () => 0 });
    expect(seq.next('msg-a')).toBe(1);
    expect(seq.next('msg-a')).toBe(2);
    expect(seq.next('msg-a')).toBe(3);
  });

  it('不同 msg_id 各自独立计数', () => {
    const seq = new MessageSequence({ now: () => 0 });
    expect(seq.next('a')).toBe(1);
    expect(seq.next('b')).toBe(1);
    expect(seq.next('a')).toBe(2);
    expect(seq.next('b')).toBe(2);
  });

  it('超过 TTL 后过期并从 1 重新开始', () => {
    let now = 0;
    const seq = new MessageSequence({ ttlMs: 1000, now: () => now });
    expect(seq.next('m')).toBe(1);
    expect(seq.next('m')).toBe(2);

    now = 999;
    expect(seq.next('m')).toBe(3);

    // 距最后一次使用已过 1000ms，条目过期。
    now = 1999;
    expect(seq.next('m')).toBe(1);
  });

  it('prune 清理过期条目并返回数量', () => {
    let now = 0;
    const seq = new MessageSequence({ ttlMs: 100, now: () => now });
    seq.next('a');
    seq.next('b');
    now = 50;
    seq.next('c');
    expect(seq.size()).toBe(3);

    now = 101;
    // a、b 的最后使用时间在 0，已过期；c 在 50，尚未过期。
    expect(seq.prune()).toBe(2);
    expect(seq.size()).toBe(1);
    expect(seq.next('c')).toBe(2);
  });

  it('容量超限时淘汰最旧的键', () => {
    const seq = new MessageSequence({ maxEntries: 2, now: () => 0 });
    expect(seq.next('a')).toBe(1);
    expect(seq.next('b')).toBe(1);
    // 插入 c 触发淘汰：a 是最旧的键。
    expect(seq.next('c')).toBe(1);
    expect(seq.size()).toBe(2);
    // b 仍在，计数继续递增。
    expect(seq.next('b')).toBe(2);
  });

  it('forget 与 clear 重置计数', () => {
    const seq = new MessageSequence({ now: () => 0 });
    seq.next('a');
    seq.next('a');
    expect(seq.forget('a')).toBe(true);
    expect(seq.forget('a')).toBe(false);
    expect(seq.next('a')).toBe(1);

    seq.next('b');
    seq.clear();
    expect(seq.size()).toBe(0);
    expect(seq.next('b')).toBe(1);
  });
});
