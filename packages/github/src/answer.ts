/**
 * 分析结论的唯一契约。
 *
 * 取代此前分散在三处的校验：JSON Schema 文件、渲染器的字段检查、写回前的类型检查。
 * 现在只有一份 Zod Schema，解析成功即得到已收窄的类型，下游不再重复判断。
 *
 * 与 `schemas/answer.schema.json` 的差异只有一处：`conclusion` 与 `root_cause`
 * 先 trim 再判长度，避免用纯空白凑够最小长度。
 */
import { z } from 'zod';

export const IssueTypeSchema = z.enum(['bug', 'enhancement', 'rfc', 'unknown']);

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const EvidenceSchema = z
  .object({
    summary: z.string().trim().min(1).max(800),
    file: z.string().max(400).optional(),
    line_start: z.number().int().min(1).optional(),
    line_stop: z.number().int().min(1).optional(),
    ref: z.string().max(800).optional(),
  })
  .strict();

export const AnswerSchema = z
  .object({
    issue_type: IssueTypeSchema,
    issue_summary: z.array(z.string().trim().min(1).max(400)).min(1).max(10),
    conclusion: z.string().trim().min(10).max(4000),
    root_cause: z.string().trim().min(10).max(6000),
    confidence: ConfidenceSchema,
    confidence_reason: z.string().max(800),
    evidence: z.array(EvidenceSchema).max(40),
    user_advice: z.array(z.string().max(600)).max(10),
    fix_plan: z.array(z.string().max(800)).max(20),
    ai_fix_hint: z.string().max(4000).optional(),
    affected_versions: z.array(z.string().max(80)).optional(),
    labels: z.array(z.string().max(80)),
    partial: z.boolean(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

export type IssueType = z.infer<typeof IssueTypeSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Answer = z.infer<typeof AnswerSchema>;

export class AnswerValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`分析结论不符合契约: ${issues.join('; ')}`);
    this.name = 'AnswerValidationError';
    this.issues = [...issues];
  }
}

export type AnswerParseResult =
  | { readonly ok: true; readonly answer: Answer }
  | { readonly ok: false; readonly issues: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function safeParseAnswer(input: unknown): AnswerParseResult {
  const result = AnswerSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, issues: formatIssues(result.error) };
  }
  return { ok: true, answer: result.data };
}

/** 解析失败即抛出，错误里带逐条问题，便于直接写进失败评论或日志。 */
export function parseAnswer(input: unknown): Answer {
  const result = safeParseAnswer(input);
  if (!result.ok) {
    throw new AnswerValidationError(result.issues);
  }
  return result.answer;
}
