import { describe, expect, it } from 'vitest';

import { BOT_STOP_MARKER, withBotStop } from '../src/handlers/issue.ts';
import { RpcError, RpcTaskError } from '../src/rpc-clients.ts';
import { createHarness, message } from './helpers.ts';

describe('/issue 多轮引用细化', () => {
  it('一次一问补齐字段后建 Issue，并把链接发回群里', async () => {
    const harness = createHarness();
    harness.agent.drafts.push({
      title: '合成器在 1.21.1 崩溃',
      body: '## 现象\n\n打开合成器即崩溃。',
      labels: ['bug', 'scope:machine'],
    });

    const opened = await harness.router.handle(message({ id: 'f-1', content: '/issue 合成器崩溃' }));
    expect(opened.action).toBe('handled');
    expect(harness.replier.texts[0]).toContain('版本');

    const version = await harness.router.handle(
      message({ id: 'f-2', content: '1.21.1', quotedRefIndex: 'ref-1' }),
    );
    expect(version.action).toBe('continued');
    expect(harness.replier.texts[1]).toContain('复现步骤');

    const steps = await harness.router.handle(
      message({
        id: 'f-3',
        content: '启动游戏 → 打开合成器 → 放入物品',
        quotedRefIndex: 'ref-2',
      }),
    );
    expect(steps.action).toBe('continued');
    expect(harness.replier.texts[2]).toContain('期望结果');

    const expected = await harness.router.handle(
      message({ id: 'f-4', content: '正常显示配方列表', quotedRefIndex: 'ref-3' }),
    );
    expect(expected.action).toBe('continued');
    expect(harness.replier.texts[3]).toContain('已受理');

    await harness.router.whenIdle();

    expect(harness.agent.submissions).toHaveLength(1);
    expect(harness.agent.submissions[0]).toEqual({
      kind: 'issue-draft',
      repo: 'gregtech6ce/gregtech6',
      scope: 'group:g-1',
      requester: 'u-maintainer',
      draft: {
        title: '合成器崩溃',
        version: '1.21.1',
        steps: '启动游戏 → 打开合成器 → 放入物品',
        expected: '正常显示配方列表',
      },
    });
    expect(harness.agent.waited).toEqual(['task-1']);

    expect(harness.writer.requests).toHaveLength(1);
    const request = harness.writer.requests[0];
    expect(request).toMatchObject({
      repo: 'gregtech6ce/gregtech6',
      title: '合成器在 1.21.1 崩溃',
      labels: ['bug', 'scope:machine'],
    });
    expect(request?.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(request?.body.endsWith(BOT_STOP_MARKER)).toBe(true);
    expect(harness.replier.lastText()).toContain('#42');
    expect(harness.replier.lastText()).toContain('https://github.com/gregtech6ce/gregtech6/issues/42');
  });

  it('信息一次写全时直接受理', async () => {
    const harness = createHarness();
    harness.agent.drafts.push({ title: '崩溃', body: '正文', labels: [] });

    const outcome = await harness.router.handle(
      message({
        id: 'o-1',
        content: [
          '/issue 合成器崩溃',
          '版本：1.21.1',
          '复现：打开合成器',
          '期望：正常显示',
        ].join('\n'),
      }),
    );

    expect(outcome.action).toBe('handled');
    await harness.router.whenIdle();

    expect(harness.replier.texts[0]).toContain('已受理');
    expect(harness.agent.submissions[0]?.draft).toEqual({
      title: '合成器崩溃',
      version: '1.21.1',
      steps: '打开合成器',
      expected: '正常显示',
    });
    expect(harness.replier.texts[1]).toContain('#42');
  });

  it('引用回复可以用「标题：」改写标题', async () => {
    const harness = createHarness();
    harness.agent.drafts.push({ title: '最终标题', body: '正文', labels: [] });

    await harness.router.handle(message({ id: 't-1', content: '/issue 旧标题' }));
    const renamed = await harness.router.handle(
      message({ id: 't-2', content: '标题：更精确的崩溃描述', quotedRefIndex: 'ref-1' }),
    );

    expect(renamed.action).toBe('continued');
    // 标题已改，但版本仍然缺失，应继续问版本。
    expect(harness.replier.texts[1]).toContain('版本');
    const session = harness.sessions.resolveKey('r:ref-1');
    expect(session?.fields.title).toBe('更精确的崩溃描述');
  });

  it('提交后再引用回复不会重复建单', async () => {
    const harness = createHarness();
    harness.agent.drafts.push({ title: '崩溃', body: '正文', labels: [] });

    await harness.router.handle(
      message({
        id: 'd-1',
        content: '/issue 崩溃\n版本：1.21.1\n复现：打开合成器\n期望：正常',
      }),
    );
    await harness.router.whenIdle();
    const again = await harness.router.handle(
      message({ id: 'd-2', content: '再补充一点', quotedRefIndex: 'ref-1' }),
    );

    expect(again.action).toBe('continued');
    expect(harness.replier.lastText()).toContain('已经受理过了');
    expect(harness.agent.submissions).toHaveLength(1);
    expect(harness.writer.requests).toHaveLength(1);
  });

  it('平台未返回 ref_idx 时仍按 message_id 绑定会话', async () => {
    const harness = createHarness();
    // 模拟平台只回消息 id、不回 ext_info.ref_idx 的情况。
    harness.replier.omitRefIndexes = true;

    await harness.router.handle(message({ id: 'n-1', content: '/issue 崩溃' }));

    expect(harness.sessions.resolveKey('m:bot-1')).toBeDefined();
    expect(harness.sessions.resolveKey('r:undefined')).toBeUndefined();
  });
});

describe('/issue 失败路径', () => {
  it('分析任务失败时回可读原因，不建 Issue', async () => {
    const harness = createHarness();
    harness.agent.error = new RpcTaskError('task-1', 'upstream exploded');

    await harness.router.handle(
      message({
        id: 'e-1',
        content: '/issue 崩溃\n版本：1.21.1\n复现：打开合成器\n期望：正常',
      }),
    );
    await harness.router.whenIdle();

    expect(harness.writer.requests).toHaveLength(0);
    expect(harness.replier.lastText()).toContain('分析任务失败或超时');
    expect(harness.replier.lastText()).not.toContain('upstream exploded');
  });

  it('写回服务不可用时提示 HTTP 状态', async () => {
    const harness = createHarness();
    harness.agent.drafts.push({ title: '崩溃', body: '正文', labels: [] });
    harness.writer.error = new RpcError({
      status: 503,
      endpoint: 'http://writer',
      path: '/issues',
      detail: 'unavailable',
    });

    await harness.router.handle(
      message({
        id: 'e-2',
        content: '/issue 崩溃\n版本：1.21.1\n复现：打开合成器\n期望：正常',
      }),
    );
    await harness.router.whenIdle();

    expect(harness.replier.lastText()).toContain('后端服务返回 HTTP 503');
  });
});

describe('bot:stop 标记', () => {
  it('attachBotStop=true 时追加标记，且不会重复追加', () => {
    expect(withBotStop('正文', false)).toBe('正文');
    expect(withBotStop('正文', true)).toBe(`正文\n\n${BOT_STOP_MARKER}`);
    expect(withBotStop(`正文\n\n${BOT_STOP_MARKER}`, true)).toBe(`正文\n\n${BOT_STOP_MARKER}`);
    expect(BOT_STOP_MARKER).toBe('<!-- bot:v1:stop -->');
  });

  it('群配置关闭时不追加标记', async () => {
    const harness = createHarness({ attachBotStop: false });
    harness.agent.drafts.push({ title: '崩溃', body: '正文', labels: [] });

    await harness.router.handle(
      message({
        id: 's-1',
        content: '/issue 崩溃\n版本：1.21.1\n复现：打开合成器\n期望：正常',
      }),
    );
    await harness.router.whenIdle();

    expect(harness.writer.requests[0]?.body).toBe('正文');
  });
});
