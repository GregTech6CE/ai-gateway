/**
 * 与 QQ 侧对齐的 REST 契约。
 *
 * schema 定义在 `@gt6ce/shared`，三端（qqbot / agent-svc / github-svc）共用同一份；
 * 这里只重新导出并补上服务自己的执行器类型。
 */
import type { AgentTaskRequest, IssueDraft } from '@gt6ce/shared';

export {
  AgentTaskRequestSchema,
  AgentTaskSnapshotSchema,
  IssueDraftInputSchema,
  TaskAcceptedSchema,
} from '@gt6ce/shared';
export type {
  AgentTaskRequest,
  AgentTaskSnapshot,
  IssueDraftInput,
} from '@gt6ce/shared';

/** 任务执行器：由模型池实现，测试可替换成内存实现。 */
export type DraftExecutor = (request: AgentTaskRequest, signal: AbortSignal) => Promise<IssueDraft>;
