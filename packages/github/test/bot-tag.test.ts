import { describe, expect, it } from 'vitest';

import {
  formatDoneTag,
  formatFailedTag,
  formatPendingTag,
  formatStopTag,
  parseBotTags,
  shouldSkipPassiveTrigger,
  type PassiveTriggerComment,
} from '../src/bot-tag.ts';

const NOW = new Date('2026-11-16T10:00:00Z');
const RECENT_ISSUE = '2026-11-14T10:00:00Z';
const OLD_ISSUE = '2026-11-01T10:00:00Z';

function comment(body: string, minutesAgo?: number): PassiveTriggerComment {
  return minutesAgo === undefined
    ? { body }
    : { body, createdAt: new Date(NOW.getTime() - minutesAgo * 60_000) };
}

describe('标记格式与解析', () => {
  it('四种标记的生成结果符合协议', () => {
    expect(formatStopTag()).toBe('<!-- bot:v1:stop -->');
    expect(formatPendingTag('123')).toBe('<!-- bot:v1:pending run=123 -->');
    expect(formatDoneTag('456', 'success')).toBe('<!-- bot:v1:done type=success run=456 -->');
    expect(formatDoneTag('456', 'rejected')).toBe('<!-- bot:v1:done type=rejected run=456 -->');
    expect(formatFailedTag('789')).toBe('<!-- bot:v1:failed run=789 -->');
  });

  it('解析回同样的语义', () => {
    expect(parseBotTags(formatStopTag())).toEqual([{ kind: 'stop', runId: '' }]);
    expect(parseBotTags(formatPendingTag('123'))).toEqual([{ kind: 'pending', runId: '123' }]);
    expect(parseBotTags(formatDoneTag('456', 'rejected'))).toEqual([
      { kind: 'done', runId: '456', doneType: 'rejected' },
    ]);
    expect(parseBotTags(formatFailedTag('789'))).toEqual([{ kind: 'failed', runId: '789' }]);
  });

  it('一段正文里的多个标记按出现顺序解析', () => {
    const text = `${formatPendingTag('1')}\n中间正文\n${formatFailedTag('1')}`;
    expect(parseBotTags(text).map((tag) => tag.kind)).toEqual(['pending', 'failed']);
  });

  it('忽略旧格式与其他 HTML 注释', () => {
    expect(parseBotTags('<!-- lily:done repo=o/r issue=1 -->')).toEqual([]);
    expect(parseBotTags('<!-- 普通注释 -->')).toEqual([]);
  });

  it('run id 里的危险字符被剔除', () => {
    expect(formatPendingTag('12 34>')).toBe('<!-- bot:v1:pending run=1234 -->');
    expect(formatFailedTag('')).toBe('<!-- bot:v1:failed run=unknown -->');
  });
});

describe('shouldSkipPassiveTrigger', () => {
  it('force 无视全部标记与时间窗口', () => {
    const decision = shouldSkipPassiveTrigger({
      force: true,
      now: NOW,
      issueCreatedAt: OLD_ISSUE,
      comments: [comment(formatStopTag()), comment(formatDoneTag('1', 'success'))],
    });
    expect(decision).toEqual({ skip: false, reason: 'forced' });
  });

  it('stop 标记跳过', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      comments: [comment(formatStopTag())],
    });
    expect(decision).toEqual({ skip: true, reason: 'stop-tag' });
  });

  it('done 标记跳过（success 与 rejected 同等对待）', () => {
    for (const done of [formatDoneTag('1', 'success'), formatDoneTag('2', 'rejected')]) {
      const decision = shouldSkipPassiveTrigger({
        now: NOW,
        issueCreatedAt: RECENT_ISSUE,
        comments: [comment(done)],
      });
      expect(decision).toEqual({ skip: true, reason: 'done-tag' });
    }
  });

  it('failed 不阻断重试', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      comments: [comment(formatFailedTag('1'))],
    });
    expect(decision).toEqual({ skip: false, reason: 'eligible' });
  });

  it('未过期的 pending 跳过', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      comments: [comment(formatPendingTag('1'), 10)],
    });
    expect(decision).toEqual({ skip: true, reason: 'pending' });
  });

  it('超过 70 分钟的 pending 允许重跑', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      comments: [comment(formatPendingTag('1'), 71)],
    });
    expect(decision).toEqual({ skip: false, reason: 'eligible' });
  });

  it('pending 缺时间戳时按仍在进行中处理', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      comments: [{ body: formatPendingTag('1') }],
    });
    expect(decision).toEqual({ skip: true, reason: 'pending' });
  });

  it('自定义 pending 窗口', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      pendingWindowMinutes: 5,
      comments: [comment(formatPendingTag('1'), 10)],
    });
    expect(decision).toEqual({ skip: false, reason: 'eligible' });
  });

  it('issue 超过 7 天跳过被动触发', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: OLD_ISSUE,
      comments: [],
    });
    expect(decision).toEqual({ skip: true, reason: 'issue-too-old' });
  });

  it('自定义 maxIssueAgeDays', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      maxIssueAgeDays: 1,
    });
    expect(decision).toEqual({ skip: true, reason: 'issue-too-old' });
  });

  it('近期 issue 且无阻断标记时放行', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: RECENT_ISSUE,
      comments: [],
    });
    expect(decision).toEqual({ skip: false, reason: 'eligible' });
  });

  it('issue 创建时间不可解析时不按超期处理', () => {
    const decision = shouldSkipPassiveTrigger({
      now: NOW,
      issueCreatedAt: 'not-a-date',
    });
    expect(decision).toEqual({ skip: false, reason: 'eligible' });
  });
});
