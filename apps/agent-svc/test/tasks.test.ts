import { describe, expect, it } from 'vitest';

import type { AgentTaskRequest } from '../src/contracts.ts';
import { TaskStore } from '../src/tasks.ts';

const REQUEST: AgentTaskRequest = {
  kind: 'issue-draft',
  repo: 'o/r',
  scope: 'group:g',
  requester: 'u',
  draft: {
    title: '崩溃',
    version: '1.21.1',
    steps: '打开合成器',
    expected: '正常显示',
  },
};

function store(options: { ttlMs?: number; maxTasks?: number; now?: () => number } = {}): TaskStore {
  let counter = 0;
  return new TaskStore({
    ttlMs: options.ttlMs ?? 60_000,
    maxTasks: options.maxTasks ?? 10,
    ...(options.now ? { now: options.now } : {}),
    idFactory: () => `task-${(counter += 1)}`,
  });
}

describe('TaskStore', () => {
  it('创建后为 queued，状态按顺序流转', () => {
    const tasks = store();
    const task = tasks.create(REQUEST);

    expect(task.status).toBe('queued');
    expect(tasks.snapshot(task.id)).toEqual({ id: 'task-1', status: 'queued' });

    expect(tasks.markRunning(task.id)).toBe(true);
    expect(tasks.snapshot(task.id)?.status).toBe('running');

    expect(
      tasks.succeed(task.id, { title: 't', body: 'b', labels: ['bug'] }),
    ).toBe(true);
    expect(tasks.snapshot(task.id)).toEqual({
      id: 'task-1',
      status: 'succeeded',
      result: { title: 't', body: 'b', labels: ['bug'] },
    });
  });

  it('失败写入稳定文案并清掉结果', () => {
    const tasks = store();
    const task = tasks.create(REQUEST);
    tasks.markRunning(task.id);
    tasks.fail(task.id, '分析超时');

    expect(tasks.snapshot(task.id)).toEqual({
      id: 'task-1',
      status: 'failed',
      error: '分析超时',
    });
  });

  it('不能把非 queued 任务标记为 running', () => {
    const tasks = store();
    const task = tasks.create(REQUEST);
    tasks.markRunning(task.id);

    expect(tasks.markRunning(task.id)).toBe(false);
  });

  it('超过 TTL 后查询不到', () => {
    let now = 0;
    const tasks = store({ ttlMs: 1_000, now: () => now });
    const task = tasks.create(REQUEST);

    now = 1_001;
    expect(tasks.snapshot(task.id)).toBeUndefined();
    expect(tasks.size()).toBe(0);
  });

  it('容量超限时优先淘汰终态任务', () => {
    const tasks = store({ maxTasks: 2 });
    const first = tasks.create(REQUEST);
    tasks.succeed(first.id, { title: 't', body: 'b', labels: [] });
    const second = tasks.create(REQUEST);
    tasks.markRunning(second.id);
    const third = tasks.create(REQUEST);

    expect(tasks.size()).toBe(2);
    expect(tasks.snapshot(first.id)).toBeUndefined();
    expect(tasks.snapshot(second.id)?.status).toBe('running');
    expect(tasks.snapshot(third.id)?.status).toBe('queued');
  });

  it('快照不包含原始请求体', () => {
    const tasks = store();
    const task = tasks.create(REQUEST);
    const snapshot = tasks.snapshot(task.id);

    expect(snapshot).not.toHaveProperty('request');
  });
});
