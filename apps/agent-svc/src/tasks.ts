/**
 * 内存任务表。
 *
 * 任务只是「一次分析请求的状态」，没有跨重启价值：TTL 到期或容量超限就丢。持久化会让
 * 服务多一个需要备份的状态源，而 QQ 侧对失败/过期的处理本来就是提示用户重试。
 */
import { randomUUID } from 'node:crypto';

import type { IssueDraft } from '@gt6ce/agent';

import type { AgentTaskRequest, AgentTaskSnapshot } from './contracts.ts';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface TaskRecord {
  readonly id: string;
  status: TaskStatus;
  readonly request: AgentTaskRequest;
  result?: IssueDraft;
  error?: string;
  readonly createdAt: number;
  updatedAt: number;
}

export interface TaskStoreOptions {
  readonly ttlMs: number;
  readonly maxTasks: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  private readonly ttlMs: number;

  private readonly maxTasks: number;

  private readonly now: () => number;

  private readonly idFactory: () => string;

  constructor(options: TaskStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.maxTasks = options.maxTasks;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  create(request: AgentTaskRequest): TaskRecord {
    this.prune();
    const current = this.now();
    const record: TaskRecord = {
      id: this.idFactory(),
      status: 'queued',
      request,
      createdAt: current,
      updatedAt: current,
    };
    this.tasks.set(record.id, record);
    this.enforceCapacity();
    return record;
  }

  get(id: string): TaskRecord | undefined {
    const record = this.tasks.get(id);
    if (!record) {
      return undefined;
    }
    if (record.updatedAt + this.ttlMs <= this.now()) {
      this.tasks.delete(id);
      return undefined;
    }
    return record;
  }

  markRunning(id: string): boolean {
    const record = this.tasks.get(id);
    if (!record || record.status !== 'queued') {
      return false;
    }
    record.status = 'running';
    record.updatedAt = this.now();
    return true;
  }

  succeed(id: string, result: IssueDraft): boolean {
    const record = this.tasks.get(id);
    if (!record) {
      return false;
    }
    record.status = 'succeeded';
    record.result = result;
    delete record.error;
    record.updatedAt = this.now();
    return true;
  }

  fail(id: string, error: string): boolean {
    const record = this.tasks.get(id);
    if (!record) {
      return false;
    }
    record.status = 'failed';
    record.error = error;
    delete record.result;
    record.updatedAt = this.now();
    return true;
  }

  /** 轮询视图：只暴露契约字段，不把内部请求体原样带出去。 */
  snapshot(id: string): AgentTaskSnapshot | undefined {
    const record = this.get(id);
    if (!record) {
      return undefined;
    }
    return {
      id: record.id,
      status: record.status,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  /** 清理过期任务，返回清理数量。 */
  prune(): number {
    const current = this.now();
    let removed = 0;
    for (const [id, record] of this.tasks) {
      if (record.updatedAt + this.ttlMs <= current) {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.tasks.size;
  }

  /** 超限时先淘汰终态任务；全是进行中时淘汰最旧的一条，避免无界增长。 */
  private enforceCapacity(): void {
    while (this.tasks.size > this.maxTasks) {
      const terminal = [...this.tasks.values()].find(
        (record) => record.status === 'succeeded' || record.status === 'failed',
      );
      const oldest = this.tasks.values().next().value as TaskRecord | undefined;
      const target = terminal ?? oldest;
      if (!target) {
        return;
      }
      this.tasks.delete(target.id);
    }
  }
}
