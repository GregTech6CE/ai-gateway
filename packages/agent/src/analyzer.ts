/**
 * 基于 Vercel AI SDK 的分析执行器。
 *
 * 取代旧版 `codex` CLI 子进程与 `responses_bridge`：不再解析人类可读日志、不再维护
 * 协议桥，模型通过工具读取工作区，最终用 `Output.object` 产出强类型的 `Answer`。
 *
 * 同一套执行器服务三个场景：CI 的 issue 分析、QQ 问答与原版行为分析——差异只在
 * 调用方传入的提示词模板与工具集。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AnswerSchema, redactText, type Answer } from '@gt6ce/shared';
import { Output, generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';

import { toModelError } from './model-pool.ts';
import type { ModelEntry } from './model-pool.ts';
import {
  describeStructuredOutputFailure,
  extractJsonObject,
  recoverFromText,
  structuredOutputFailure,
} from './output-errors.ts';

/** 调用方显式传入的模型目标；不读环境变量，凭据由上层按阶段注入。 */
export interface ModelTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Record<string, string>;
  readonly providerName?: string;
  /**
   * provider 是否支持 JSON Schema 形式的 `response_format`，默认 `true`。
   *
   * 关掉时 `Output.object` 的 schema 不会下发，模型按自由文本作答——只有在网关确实
   * 不支持时才应传 `false`，否则等于主动放弃结构化保证。
   */
  readonly supportsStructuredOutputs?: boolean;
}

/** 兼容 OpenAI Chat Completions 的 provider，`config/models.json` 里两个入口都属于这一类。 */
export function createChatModel(target: ModelTarget): LanguageModel {
  const provider = createOpenAICompatible({
    name: target.providerName ?? 'gt6ce',
    baseURL: target.baseUrl,
    apiKey: target.apiKey,
    headers: target.headers ?? {},
    supportsStructuredOutputs: target.supportsStructuredOutputs ?? true,
  });
  return provider.chatModel(target.model);
}

/** 由池入口与 key 构造模型；CI 与后续服务都用这个签名注入，避免直接依赖 `ai`。 */
export type ModelFactory = (entry: ModelEntry, apiKey: string) => LanguageModel;

/** 提示词模板：system 承载规则，user 承载本次输入。 */
export interface PromptTemplate {
  readonly system: string;
  readonly user: string;
  /** 仓库档案名，仅用于结果回溯，不参与请求。 */
  readonly profile?: string;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

const RelevancePayloadSchema = z.object({
  relevance: z.enum(['in_scope', 'spam', 'out_of_scope']),
  confidence: z.number().optional(),
  reason: z.string().optional(),
  evidence: z.array(z.unknown()).optional(),
});

export type RelevanceCategory = 'in_scope' | 'spam' | 'out_of_scope';

export interface RelevanceVerdict {
  readonly relevance: RelevanceCategory;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: string[];
}

export interface ClassifyRelevanceOptions {
  readonly model: LanguageModel;
  readonly prompt: PromptTemplate;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * 轻量相关性判断。
 *
 * 与旧版一致：**传输层错误**以 `ModelError` 抛出，由调用方计罚并切换入口；
 * **回答不可解析**只说明这次分类没给出结论（返回 undefined），请求本身是成功的，
 * 不应把入口判成故障。
 */
export async function classifyRelevance(
  options: ClassifyRelevanceOptions,
): Promise<RelevanceVerdict | undefined> {
  let text: string;
  try {
    const result = await generateText({
      model: options.model,
      system: options.prompt.system,
      prompt: options.prompt.user,
      temperature: 0,
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(options.timeoutMs !== undefined
        ? { abortSignal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    });
    text = result.text;
  } catch (error) {
    throw toModelError(error);
  }

  const raw = extractJsonObject(text);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = RelevancePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return {
    relevance: parsed.data.relevance,
    confidence: clamp01(parsed.data.confidence ?? 0),
    reason: redactText(parsed.data.reason ?? '').slice(0, 800),
    evidence: (parsed.data.evidence ?? [])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => redactText(item).slice(0, 500))
      .slice(0, 10),
  };
}

export interface AnalysisStep {
  readonly index: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
}

export interface AnalyzeIssueOptions {
  readonly model: LanguageModel;
  readonly prompt: PromptTemplate;
  readonly tools: ToolSet;
  /** 工具循环的硬上限；默认 60，防止单次分析无限调用工具。 */
  readonly maxSteps?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly onStep?: (step: AnalysisStep) => void;
}

export interface AnalysisOutcome {
  readonly answer: Answer;
  readonly profile: string;
  readonly steps: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  /** 已脱敏的模型文本，可直接写日志。 */
  readonly text: string;
  readonly finishReason: string;
}

/**
 * 产出结构化结论。
 *
 * `Output.object({ schema: AnswerSchema })` 让 provider 按 schema 约束输出，SDK 负责
 * 解析与校验；拿到 `undefined` 说明模型没有按契约收尾，按失败处理而不是猜默认值。
 */
export async function analyzeIssue(options: AnalyzeIssueOptions): Promise<AnalysisOutcome> {
  const maxSteps = options.maxSteps ?? 60;
  const abortSignal =
    options.abortSignal ??
    (options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined);

  let result;
  try {
    result = await generateText({
      model: options.model,
      system: options.prompt.system,
      prompt: options.prompt.user,
      tools: options.tools,
      stopWhen: stepCountIs(maxSteps),
      output: Output.object({ schema: AnswerSchema }),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      onStepFinish: (step) => {
        options.onStep?.({
          index: step.stepNumber,
          text: redactText(step.text),
          toolCalls: step.toolCalls.map((call) => ({
            name: call.toolName,
            input: call.input,
          })),
        });
      },
    });
  } catch (error) {
    // 「请求成功、但模型没按契约产出对象」不是传输故障：先试一次兜底解析，仍失败就抛
    // AgentError 快速失败。绝不能交给 toModelError——那会变成 network 并触发 60s 重试，
    // 还会把健康入口冷却数小时。
    const failure = structuredOutputFailure(error);
    if (failure) {
      const recovered = recoverFromText(failure.text, AnswerSchema);
      if (recovered) {
        const usage = failure.usage;
        const input = usage?.inputTokens ?? 0;
        const output = usage?.outputTokens ?? 0;
        return {
          answer: recovered,
          profile: options.prompt.profile ?? '',
          // SDK 抛错时拿不到步数；如实写 0，不猜。
          steps: 0,
          tokens: { input, output, total: usage?.totalTokens ?? input + output },
          text: redactText(failure.text ?? ''),
          finishReason: failure.finishReason ?? 'unknown',
        };
      }
      throw new AgentError(describeStructuredOutputFailure(error));
    }
    throw toModelError(error);
  }

  const answer = result.output;
  if (!answer) {
    throw new AgentError('模型没有按契约产出结构化结论');
  }

  const usage = result.usage;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;

  return {
    answer,
    profile: options.prompt.profile ?? '',
    steps: result.steps.length,
    tokens: { input, output, total },
    text: redactText(result.text),
    finishReason: result.finishReason,
  };
}
