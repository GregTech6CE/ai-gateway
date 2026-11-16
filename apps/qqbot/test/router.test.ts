import { describe, expect, it } from 'vitest';

import { GROUP, MAINTAINER, OUTSIDER, createHarness, message } from './helpers.ts';

describe('CommandRouter 去重与绑定', () => {
  it('同一条 message_id 只处理一次', async () => {
    const harness = createHarness();

    const first = await harness.router.handle(message({ id: 'm-1', content: '/help' }));
    const second = await harness.router.handle(message({ id: 'm-1', content: '/help' }));

    expect(first.action).toBe('handled');
    expect(second.action).toBe('duplicate');
    expect(harness.replier.sent).toHaveLength(1);
  });

  it('未绑定仓库的会话收到绑定提示，且提示只发一次', async () => {
    const harness = createHarness({ withBinding: false });

    const outcome = await harness.router.handle(message({ id: 'm-2', content: '/help' }));

    expect(outcome.action).toBe('unbound');
    expect(harness.replier.lastText()).toContain('还没有绑定仓库');
    expect(harness.replier.lastText()).toContain('bindings');
  });

  it('未绑定会话里的闲聊不触发提示', async () => {
    const harness = createHarness({ withBinding: false });

    const outcome = await harness.router.handle(message({ id: 'm-3', content: '今天天气不错' }));

    expect(outcome.action).toBe('ignored');
    expect(harness.replier.sent).toHaveLength(0);
  });

  it('未知命令给出提示', async () => {
    const harness = createHarness();

    const outcome = await harness.router.handle(message({ id: 'm-4', content: '/deploy 上线' }));

    expect(outcome.action).toBe('unknown-command');
    expect(harness.replier.lastText()).toContain('没有 /deploy');
  });

  it('未启用的命令被拦截', async () => {
    const harness = createHarness({ allowedCommands: ['help'] });

    const outcome = await harness.router.handle(message({ id: 'm-5', content: '/issue 崩溃' }));

    expect(outcome.action).toBe('command-not-allowed');
    expect(harness.replier.lastText()).toContain('未启用 /issue');
  });

  it('非维护者不能执行写操作，命令仍可用', async () => {
    const harness = createHarness();

    const denied = await harness.router.handle(
      message({ id: 'm-6', content: '/issue 崩溃', senderId: OUTSIDER }),
    );
    const allowed = await harness.router.handle(
      message({ id: 'm-7', content: '/help', senderId: OUTSIDER }),
    );

    expect(denied.action).toBe('forbidden');
    expect(harness.replier.texts[0]).toContain('仅限本会话维护者');
    expect(allowed.action).toBe('handled');
  });

  it('机器人自己发的消息不参与路由', async () => {
    const harness = createHarness();

    const outcome = await harness.router.handle(
      message({ id: 'm-9', content: '/issue 崩溃', senderIsBot: true }),
    );

    expect(outcome).toMatchObject({ action: 'ignored', detail: 'bot-sender' });
    expect(harness.replier.sent).toHaveLength(0);
  });

  it('全角斜杠与大小写命令名都能识别', async () => {
    const harness = createHarness();

    const outcome = await harness.router.handle(message({ id: 'm-8', content: '／HELP' }));

    expect(outcome).toMatchObject({ action: 'handled', command: 'help' });
  });
});

describe('/help', () => {
  it('列出可用命令、当前仓库与示例', async () => {
    const harness = createHarness();

    const outcome = await harness.router.handle(
      message({ id: 'h-1', content: '/help', senderId: MAINTAINER }),
    );

    expect(outcome.action).toBe('handled');
    const text = harness.replier.lastText();
    expect(text).toContain('/help');
    expect(text).toContain('/issue <标题>');
    expect(text).toContain('gregtech6ce/gregtech6');
    expect(text).toContain('/issue 合成器在 1.21.1 加载配方时崩溃');
    expect(harness.replier.sent[0]?.options?.markdown).toBe(true);
  });

  it('未启用 /issue 时提示没有写操作命令', async () => {
    const harness = createHarness({ allowedCommands: ['help'] });

    await harness.router.handle(message({ id: 'h-2', content: '/help' }));

    const text = harness.replier.lastText();
    expect(text).toContain('/help');
    expect(text).not.toContain('/issue <标题>');
    expect(text).toContain('暂未启用写操作命令');
  });
});

describe('/issue 入口校验', () => {
  it('缺少标题时只回用法，不建立会话', async () => {
    const harness = createHarness();

    const outcome = await harness.router.handle(message({ id: 'i-1', content: '/issue' }));

    expect(outcome).toMatchObject({ action: 'handled', detail: 'missing-title' });
    expect(harness.replier.lastText()).toContain('用法：`/issue <标题>`');
    expect(harness.sessions.size()).toBe(0);
  });

  it('跨会话引用被忽略', async () => {
    const harness = createHarness();
    const session = harness.sessions.create({
      scopeKey: 'group:other',
      repo: 'gregtech6ce/gregtech6',
      requesterId: MAINTAINER,
      fields: { title: '别的群的问题' },
    });
    harness.sessions.bind(session.id, { messageIds: ['x'], refIndexes: ['ref-x'] });

    const outcome = await harness.router.handle(
      message({ id: 'i-2', content: '补充信息', quotedRefIndex: 'ref-x' }),
    );

    expect(outcome).toMatchObject({ action: 'ignored', detail: 'cross-scope' });
    expect(harness.replier.sent).toHaveLength(0);
  });

  it('引用非机器人消息时静默忽略', async () => {
    const harness = createHarness();

    const outcome = await harness.router.handle(
      message({ id: 'i-3', content: '对，就是这样', quotedRefIndex: 'ref-unknown' }),
    );

    expect(outcome).toMatchObject({ action: 'ignored', detail: 'unknown-quote' });
    expect(harness.replier.sent).toHaveLength(0);
  });
});

describe('会话键', () => {
  it('机器人的提问消息同时按 message_id 与 ref_idx 绑定', async () => {
    const harness = createHarness();

    await harness.router.handle(message({ id: 'k-1', content: '/issue 崩溃' }));

    const result = harness.replier.sent[0]?.result;
    expect(result?.messageIds).toEqual(['bot-1']);
    expect(result?.refIndexes).toEqual(['ref-1']);
    expect(harness.sessions.resolveKey('m:bot-1')).toBeDefined();
    expect(harness.sessions.resolveKey('r:ref-1')).toBeDefined();
  });

  it('群 openid 决定会话隔离', async () => {
    const harness = createHarness();

    await harness.router.handle(
      message({ id: 'k-2', content: '/issue 崩溃', scopeKey: `group:${GROUP}`, targetId: GROUP }),
    );
    const session = harness.sessions.resolveKey('r:ref-1');

    expect(session?.scopeKey).toBe(`group:${GROUP}`);
  });
});
