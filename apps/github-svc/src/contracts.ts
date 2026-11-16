/**
 * 与 QQ 侧对齐的写回契约。
 *
 * schema 定义在 `@gt6ce/shared`，qqbot 与 github-svc 共用同一份；这里只重新导出并补上
 * 服务自己的返回值类型。
 */
import type { CreatedIssue } from '@gt6ce/shared';

export { CreateIssueRequestSchema, CreatedIssueSchema } from '@gt6ce/shared';
export type { CreateIssueRequest, CreatedIssue } from '@gt6ce/shared';

export interface CreateIssueOutcome {
  readonly issue: CreatedIssue;
  /** true 表示命中幂等缓存，没有再次调用 GitHub。 */
  readonly replayed: boolean;
}
