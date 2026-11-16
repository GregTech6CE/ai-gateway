import { describe, expect, it } from 'vitest';

import { MessageDedupe, SessionStore, messageKey, refKey } from '../src/stores.ts';

describe('MessageDedupe', () => {
  it('首次见到返回 true，TTL 内重复返回 false', () => {
    let now = 0;
    const dedupe = new MessageDedupe({ ttlMs: 1_000, now: () => now });

    expect(dedupe.firstSeen('m-1')).toBe(true);
    expect(dedupe.firstSeen('m-1')).toBe(false);
    expect(dedupe.firstSeen('m-2')).toBe(true);

    now = 1_001;
    expect(dedupe.firstSeen('m-1')).toBe(true);
  });

  it('容量超限时淘汰最旧的记录', () => {
    const dedupe = new MessageDedupe({ maxEntries: 2, now: () => 0 });
    dedupe.firstSeen('a');
    dedupe.firstSeen('b');
    dedupe.firstSeen('c');

    expect(dedupe.size()).toBe(2);
    // a 已被淘汰，可以再次视为首次。
    expect(dedupe.firstSeen('a')).toBe(true);
  });
});

describe('SessionStore', () => {
  it('消息 id 与引用序号都能找回同一个会话', () => {
    const store = new SessionStore({ now: () => 0 });
    const session = store.create({
      scopeKey: 'group:g-1',
      repo: 'owner/repo',
      requesterId: 'u1',
      fields: { title: '崩溃' },
    });

    store.bind(session.id, { messageIds: ['bot-1', 'bot-2'], refIndexes: ['ref-1', undefined] });

    expect(store.resolveKey(messageKey('bot-1'))?.id).toBe(session.id);
    expect(store.resolveKey(messageKey('bot-2'))?.id).toBe(session.id);
    expect(store.resolveKey(refKey('ref-1'))?.id).toBe(session.id);
    expect(store.resolveKey(refKey('ref-2'))).toBeUndefined();
  });

  it('空闲超过 TTL 后会话过期，索引一并清理', () => {
    let now = 0;
    const store = new SessionStore({ ttlMs: 1_000, now: () => now });
    const session = store.create({
      scopeKey: 'group:g-1',
      repo: 'owner/repo',
      requesterId: 'u1',
      fields: { title: '崩溃' },
    });
    store.bind(session.id, { messageIds: ['bot-1'], refIndexes: ['ref-1'] });

    now = 500;
    store.touch(session);
    now = 1_600;
    expect(store.resolveKey(refKey('ref-1'))).toBeUndefined();
    expect(store.prune()).toBe(0);
    expect(store.size()).toBe(0);
  });

  it('容量超限时淘汰最旧的会话', () => {
    const store = new SessionStore({ maxSessions: 2, now: () => 0 });
    const first = store.create({
      scopeKey: 'group:g-1',
      repo: 'owner/repo',
      requesterId: 'u1',
      fields: { title: 'first' },
    });
    const second = store.create({
      scopeKey: 'group:g-1',
      repo: 'owner/repo',
      requesterId: 'u1',
      fields: { title: 'second' },
    });
    store.create({
      scopeKey: 'group:g-1',
      repo: 'owner/repo',
      requesterId: 'u1',
      fields: { title: 'third' },
    });

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
    expect(store.size()).toBe(2);
  });

  it('remove 清理会话及其索引', () => {
    const store = new SessionStore({ now: () => 0 });
    const session = store.create({
      scopeKey: 'group:g-1',
      repo: 'owner/repo',
      requesterId: 'u1',
      fields: { title: '崩溃' },
    });
    store.bind(session.id, { messageIds: ['bot-1'], refIndexes: ['ref-1'] });

    store.remove(session.id);

    expect(store.resolveKey(refKey('ref-1'))).toBeUndefined();
    expect(store.resolveKey(messageKey('bot-1'))).toBeUndefined();
  });
});
