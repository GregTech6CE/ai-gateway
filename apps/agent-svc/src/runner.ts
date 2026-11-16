/**
 * 任务执行器。
 *
 * 队列只在本进程内：并发上限防止一次涌入把模型额度打满；超时用 `AbortController`
 * 同时通知 provider 与等待方。失败只写稳定分类，客户端永远看不到堆栈或请求内容。
 */
import { AgentError, ModelError } from '@gt6ce/agent';
import type { Logger } from '@gt6ce/shared';

import type { DraftExecutor } from './contracts.ts';
import type { TaskStore } from './tasks.ts';

/** 内部超时标记；不进任务快照，只用于选择失败文案。 */
export class TaskTimeoutError extends Error {
  constructor() {
    super('task timeout');
    this.name = 'TaskTimeoutError';
  }
}

export function describeFailure(error: unknown): string {
  if (error instanceof TaskTimeoutError) {
    return '分析超时';
  }
  if (error instanceof ModelError) {
    return `模型服务不可用（${error.kind}）`;
  }
  if (error instanceof AgentError) {
    return '模型输出不符合契约';
  }
  return '分析失败';
}

export interface TaskRunnerOptions {
  readonly store: TaskStore;
  readonly executor: DraftExecutor;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

export class TaskRunner {
  private readonly store: TaskStore;

  private readonly executor: DraftExecutor;

  private readonly concurrency: number;

  private readonly timeoutMs: number;

  private readonly logger: Logger;

  private readonly queue: string[] = [];

  private readonly pending = new Set<Promise<void>>();

  private active = 0;

  private stopped = false;

  constructor(options: TaskRunnerOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.concurrency = options.concurrency;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  enqueue(taskId: string): void {
    if (this.stopped) {
      return;
    }
    this.queue.push(taskId);
    this.pump();
  }

  /** 等待全部任务结束；测试与优雅停机使用。 */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** 停止接收新任务，并在上限内等待在途任务。 */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([this.whenIdle().then(() => 'idle' as const), timeout]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (result === 'timeout') {
      this.logger.warn('等待在途任务超时', { timeoutMs, active: this.active });
    }
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (taskId === undefined) {
        return;
      }
      this.active += 1;
      const run = this.run(taskId).finally(() => {
        this.active -= 1;
        this.pump();
      });
      this.pending.add(run);
      void run.then(() => {
        this.pending.delete(run);
      });
    }
  }

  private async run(taskId: string): Promise<void> {
    if (!this.store.markRunning(taskId)) {
      return;
    }
    const record = this.store.get(taskId);
    if (!record) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new TaskTimeoutError()), {
        once: true,
      });
    });

    try {
      const draft = await Promise.race([
        this.executor(record.request, controller.signal),
        timedOut,
      ]);
      this.store.succeed(taskId, draft);
      this.logger.info('任务完成', {
        taskId,
        repo: record.request.repo,
        labels: draft.labels.length,
      });
    } catch (error) {
      this.logger.warn('任务失败', {
        taskId,
        repo: record.request.repo,
        error,
      });
      this.store.fail(taskId, describeFailure(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
