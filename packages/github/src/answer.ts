/**
 * 答案契约由 `@gt6ce/shared` 定义：agent 产出、github 渲染，两侧共用同一份 Zod Schema。
 * 这里保留同名导出，`@gt6ce/github` 的公共 API 不变。
 */
export {
  AnswerSchema,
  AnswerValidationError,
  ConfidenceSchema,
  EvidenceSchema,
  IssueTypeSchema,
  parseAnswer,
  safeParseAnswer,
} from '@gt6ce/shared';

export type {
  Answer,
  AnswerParseResult,
  Confidence,
  Evidence,
  IssueType,
} from '@gt6ce/shared';
