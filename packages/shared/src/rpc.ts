/**
 * 内部 RPC 契约。
 *
 * QQ 机器人、分析服务与写回服务之间没有代码依赖，但三者的请求/响应必须逐字段一致。
 * 把 schema 放在共享包里是唯一的「同一份定义」：任何一侧改动都会让另外两侧的测试
 * 同时失败，而不是等到联调时才发现字段对不上。
 */
import { z } from 'zod';

const REPO_SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** 分析结果：可直接写进 GitHub 的标题、正文与标签。 */
export const IssueDraftSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().trim().min(1).max(60_000),
  labels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
});
export type IssueDraft = z.infer<typeof IssueDraftSchema>;

/** QQ 侧收集的原始字段，未经模型改写。 */
export const IssueDraftInputSchema = z.object({
  title: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1),
  steps: z.string().trim().min(1),
  expected: z.string().trim().min(1),
  actual: z.string().trim().min(1).optional(),
});
export type IssueDraftInput = z.infer<typeof IssueDraftInputSchema>;

export const AgentTaskRequestSchema = z.object({
  kind: z.literal('issue-draft'),
  repo: z.string().regex(REPO_SLUG_PATTERN),
  scope: z.string().min(1),
  requester: z.string().min(1),
  draft: IssueDraftInputSchema,
});
export type AgentTaskRequest = z.infer<typeof AgentTaskRequestSchema>;

export const TaskAcceptedSchema = z.object({
  taskId: z.string().min(1),
});

export const AgentTaskSnapshotSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  result: IssueDraftSchema.optional(),
  error: z.string().optional(),
});
export type AgentTaskSnapshot = z.infer<typeof AgentTaskSnapshotSchema>;

export const CreatedIssueSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
});
export type CreatedIssue = z.infer<typeof CreatedIssueSchema>;

export const CreateIssueRequestSchema = z.object({
  /** 幂等键：QQ 侧用会话 id，重复提交必须返回同一个 Issue。 */
  requestId: z.string().min(1),
  repo: z.string().regex(REPO_SLUG_PATTERN),
  title: z.string().trim().min(1).max(256),
  body: z.string().trim().min(1).max(80_000),
  labels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
});
export type CreateIssueRequest = z.infer<typeof CreateIssueRequestSchema>;
