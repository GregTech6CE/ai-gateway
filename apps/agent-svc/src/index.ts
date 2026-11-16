/**
 * `@gt6ce/agent-svc` 的公共入口。
 *
 * 依赖方向固定为 `@gt6ce/agent` + `@gt6ce/shared` + `zod`：服务不接触 GitHub 凭据，
 * 也不引入 `@gt6ce/github` / `@gt6ce/qqbot`。越界引用会在类型检查阶段失败。
 */
export { AgentSvcConfigSchema, assertModelAvailable, loadAgentSvcConfig, parseAgentSvcConfig } from './config.ts';
export type { AgentSvcConfig } from './config.ts';
export {
  AgentTaskRequestSchema,
  AgentTaskSnapshotSchema,
  IssueDraftInputSchema,
  TaskAcceptedSchema,
} from './contracts.ts';
export type { AgentTaskRequest, AgentTaskSnapshot, DraftExecutor, IssueDraftInput } from './contracts.ts';
export { createDraftExecutor } from './executor.ts';
export type { DraftExecutorOptions } from './executor.ts';
export { allowedLabels, buildSystemPrompt, buildUserPrompt, loadDraftPrompt } from './prompts.ts';
export { TaskRunner, TaskTimeoutError, describeFailure } from './runner.ts';
export type { TaskRunnerOptions } from './runner.ts';
export { createAgentSvcHandler, createAgentSvcServer } from './server.ts';
export type { AgentSvcDeps, RequestHandler } from './server.ts';
export { TaskStore } from './tasks.ts';
export type { TaskRecord, TaskStatus, TaskStoreOptions } from './tasks.ts';

export const PACKAGE_NAME = '@gt6ce/agent-svc';
