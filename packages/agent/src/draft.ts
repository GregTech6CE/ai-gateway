/**
 * 结构化 Issue 草稿。
 *
 * 与 `analyzeIssue` 的区别：这里没有工具循环，也不产出 `Answer`——输入是 QQ 侧收集好的
 * 原始字段，输出是可直接写进 GitHub 的 `{ title, body, labels }`。两者共用同一套模型入口
 * 与错误归一化，避免 agent-svc 直接依赖 `ai`。
 */
import { IssueDraftSchema, type IssueDraft } from '@gt6ce/shared';
import { Output, generateText, type LanguageModel } from 'ai';

import { AgentError } from './analyzer.ts';
import { toModelError } from './model-pool.ts';
import {
  describeStructuredOutputFailure,
  recoverFromText,
  structuredOutputFailure,
} from './output-errors.ts';

/**
 * 草稿契约的唯一来源是 `@gt6ce/shared`：qqbot、agent-svc 与 github-svc 共用同一份
 * schema。这里重新导出，保持 `@gt6ce/agent` 的公共 API 不变。
 */
export { IssueDraftSchema };
export type { IssueDraft };

export interface DraftIssueOptions {
  readonly model: LanguageModel;
  readonly system: string;
  readonly user: string;
  /** 0–2；整理任务建议低温度，减少虚构。 */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * 产出结构化草稿。
 *
 * 模型没有按 schema 收尾时 `output` 为 `undefined`：按失败处理，不猜默认值。
 * 传输层错误统一转成 `ModelError`，调用方可以据此切换模型入口。
 */
export async function draftIssue(options: DraftIssueOptions): Promise<IssueDraft> {
  const abortSignal =
    options.abortSignal ??
    (options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined);

  let result;
  try {
    result = await generateText({
      model: options.model,
      system: options.system,
      prompt: options.user,
      output: Output.object({ schema: IssueDraftSchema }),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
  } catch (error) {
    // 与 analyzeIssue 一致：schema 未生效导致解析失败时，先拿模型原文兜底解析一次；
    // 仍失败则抛 AgentError——契约问题不是入口故障，不能转成 network 去冷却入口。
    const failure = structuredOutputFailure(error);
    if (failure) {
      const recovered = recoverFromText(failure.text, IssueDraftSchema);
      if (recovered) {
        return recovered;
      }
      throw new AgentError(describeStructuredOutputFailure(error));
    }
    throw toModelError(error);
  }

  const draft = result.output;
  if (!draft) {
    throw new AgentError('模型没有按契约产出结构化草稿');
  }
  // SDK 已按 schema 约束过一次；这里再 parse 一次，确保 `.default()` 生效，
  // 也让不经过 SDK 校验的测试替身同样受契约约束。
  const parsed = IssueDraftSchema.safeParse(draft);
  if (!parsed.success) {
    throw new AgentError('模型产出的草稿不符合契约');
  }
  return parsed.data;
}
