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
import { Output, generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
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
  /**
   * 失败前已完成的探索步数。
   *
   * 调用方会把它写进 `result.json`：此前失败分支硬编码 0，导致「实际跑了 60 步」
   * 在产物里显示为 0，排查时会被误导。
   */
  readonly steps?: number;
  /** 失败前已消耗的总 token。 */
  readonly tokens?: number;

  constructor(message: string, stats: { readonly steps?: number; readonly tokens?: number } = {}) {
    super(message);
    this.name = 'AgentError';
    if (stats.steps !== undefined) {
      this.steps = stats.steps;
    }
    if (stats.tokens !== undefined) {
      this.tokens = stats.tokens;
    }
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
  /**
   * 可选的硬步数上限；**不传则不限步数**。
   *
   * 生产路径不传：步数上限会与真实工作量脱钩（issue 复杂度差异很大），改由
   * `softTimeoutMs` 与死循环检测触发软着陆。保留该参数是给测试与特殊调用方用。
   */
  readonly maxSteps?: number;
  /**
   * 软截止时间：到达后不再允许调用工具，逼模型用已有证据收尾。
   *
   * 应当比整体超时（`abortSignal` / `timeoutMs`）早一段，留出收尾余量。
   */
  readonly softTimeoutMs?: number;
  /** 连续多少步出现完全相同的工具调用即判定为绕圈，默认 3。 */
  readonly loopRepeatThreshold?: number;
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
 * 分两段执行，原因是实测约束：某些 OpenAI 兼容网关（`api.cline.bot`）一旦请求里同时出现
 * `tools` 与 `response_format`，就**不再填充 `message.tool_calls`**，而是把工具调用序列化
 * 进 `message.content`。SDK 据此认为模型没有调用工具，工具循环当场结束——分析退化成
 * 「没有调查就作答」。因此这里保证：
 *
 * 1. 探索阶段只传 `tools`，绝不传 `output`（即不产生 `response_format`）；
 * 2. 探索阶段**不设步数上限**：issue 复杂度差异很大，固定步数与真实工作量脱钩。
 *    收尾由两个信号触发——软截止时间到点，或连续若干步工具调用完全重复（绕圈）；
 * 3. 触发收尾后由 `prepareStep` 清空 `activeTools` 并追加一条收尾指令，逼模型用已有
 *    证据作答；
 * 4. 探索结束后先尝试从最终文本解析 `Answer`；失败再发起一次不带 `tools` 的格式化请求。
 */
export async function analyzeIssue(options: AnalyzeIssueOptions): Promise<AnalysisOutcome> {
  const abortSignal =
    options.abortSignal ??
    (options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined);
  const loopThreshold = options.loopRepeatThreshold ?? 3;
  const softDeadline =
    options.softTimeoutMs !== undefined ? Date.now() + options.softTimeoutMs : undefined;

  let wrapUp = false;
  let instructionAppended = false;
  let lastSignature: string | undefined;
  let repeatCount = 0;
  // 失败时没有 `result`，用 onStepFinish 里的观测值兜底，避免把「跑了很多步」记成 0。
  let stepsSeen = 0;
  let tokensSeen = 0;

  let result;
  try {
    result = await generateText({
      model: options.model,
      system: options.prompt.system,
      prompt: options.prompt.user,
      tools: options.tools,
      // 未显式指定 maxSteps 时不按步数截断：循环由模型自然停止或软着陆结束。
      stopWhen: options.maxSteps !== undefined ? stepCountIs(options.maxSteps) : () => false,
      // 关键：这里不能传 output。带上 response_format 会让网关丢弃 tool_calls。
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      prepareStep: ({ messages }) => {
        if (!wrapUp) {
          return undefined;
        }
        const disableTools = { activeTools: [], toolChoice: 'none' as const };
        if (instructionAppended) {
          // 指令随 messages 覆盖向后传递，重复追加会污染上下文。
          return disableTools;
        }
        instructionAppended = true;
        return {
          ...disableTools,
          messages: [...messages, { role: 'user' as const, content: WRAP_UP_INSTRUCTION }],
        };
      },
      onStepFinish: (step) => {
        stepsSeen = step.stepNumber + 1;
        tokensSeen += step.usage.totalTokens
          ?? (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0);

        options.onStep?.({
          index: step.stepNumber,
          text: redactText(step.text),
          toolCalls: step.toolCalls.map((call) => ({
            name: call.toolName,
            input: call.input,
          })),
        });

        // 绕圈检测：连续 N 步的工具调用签名完全相同（工具名 + 参数）。
        const signature = signatureOf(step.toolCalls);
        if (signature === undefined) {
          lastSignature = undefined;
          repeatCount = 0;
        } else if (signature === lastSignature) {
          repeatCount += 1;
        } else {
          lastSignature = signature;
          repeatCount = 1;
        }
        if (signature !== undefined && repeatCount >= loopThreshold) {
          wrapUp = true;
        }

        // 软截止：到点后不再提供工具，逼模型用已有证据收尾。
        if (softDeadline !== undefined && Date.now() >= softDeadline) {
          wrapUp = true;
        }
      },
    });
  } catch (error) {
    // 没有 output 时不该出现 NoObjectGeneratedError；保留兜底是为了防 SDK 其他路径抛同类错误。
    const failure = structuredOutputFailure(error);
    if (failure) {
      const recovered = recoverFromText(failure.text, AnswerSchema);
      if (recovered) {
        return {
          answer: recovered,
          profile: options.prompt.profile ?? '',
          steps: stepsSeen,
          tokens: tokensOf(failure.usage),
          text: redactText(failure.text ?? ''),
          finishReason: failure.finishReason ?? 'unknown',
        };
      }
      throw new AgentError(describeStructuredOutputFailure(error), {
        steps: stepsSeen,
        tokens: tokensSeen,
      });
    }
    throw toModelError(error);
  }

  const explorationTokens = tokensOf(result.usage);
  const explorationSteps = result.steps.length;
  const text = result.text.trim();

  // 快速路径：模型在最后一轮直接给出了合法对象，不需要额外请求。
  if (text !== '') {
    const direct = recoverFromText(text, AnswerSchema);
    if (direct) {
      return {
        answer: direct,
        profile: options.prompt.profile ?? '',
        steps: explorationSteps,
        tokens: explorationTokens,
        text: redactText(result.text),
        finishReason: result.finishReason,
      };
    }
  }

  if (text === '' && explorationSteps === 0) {
    throw new AgentError('探索阶段没有产出可用于格式化的文本', {
      steps: 0,
      tokens: explorationTokens.total,
    });
  }

  // 格式化路径：散文收尾用文本；完全没有正文但跑过工具时，用完整消息历史收敛，
  // 避免把已经完成的调研成果丢掉。
  let formatted;
  try {
    formatted =
      text !== ''
        ? await formatAnswer({
            model: options.model,
            source: text,
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(abortSignal ? { abortSignal } : {}),
          })
        : await formatAnswer({
            model: options.model,
            // 用累积消息（含每一步的工具调用与结果），而不是最后一步的 response.messages：
            // 最后一步往往只有空正文，拿不到任何工具历史。
            messages: [
              ...result.responseMessages,
              { role: 'user' as const, content: FORMAT_FROM_MESSAGES },
            ],
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(abortSignal ? { abortSignal } : {}),
          });
  } catch (error) {
    if (error instanceof AgentError) {
      // 把探索阶段的真实消耗补回去，供 result.json 记录。
      throw new AgentError(error.message, {
        steps: explorationSteps,
        tokens: explorationTokens.total,
      });
    }
    throw error;
  }

  return {
    answer: formatted.answer,
    profile: options.prompt.profile ?? '',
    // steps 只统计探索阶段：格式化请求不是工具循环的一步。
    steps: explorationSteps,
    tokens: addTokens(explorationTokens, formatted.tokens),
    text: redactText(result.text),
    finishReason: result.finishReason,
  };
}

/** 软着陆时追加给模型的收尾指令。只要求「收尾」，不暗示结论内容。 */
const WRAP_UP_INSTRUCTION = [
  '停止调用工具。',
  '基于上面已经获得的证据，立即给出最终 JSON 结论。',
  '缺少证据的字段用保守值：confidence 取 low、partial 取 true，并在 notes 说明缺什么。',
  '只输出一个 JSON 对象，不要解释，也不要再请求任何文件。',
].join('\n');

/** 无正文时，续写在工具历史之后的一条指令。 */
const FORMAT_FROM_MESSAGES =
  '请基于以上全部调查结果，输出最终的 JSON 结论，不要再调用工具。';

/** 工具调用的稳定签名：工具名 + 参数（键排序后序列化）。 */
function signatureOf(
  toolCalls: ReadonlyArray<{ readonly toolName: string; readonly input: unknown }>,
): string | undefined {
  if (toolCalls.length === 0) {
    return undefined;
  }
  return toolCalls
    .map((call) => `${call.toolName}:${stableStringify(call.input)}`)
    .join('|');
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/**
 * 格式化阶段的 system 提示词。
 *
 * 只做「证据 → 对象」的收敛，不引入新事实：探索阶段已经完成调查，这里再做判断会让
 * 结论脱离证据。
 */
const FORMATTER_SYSTEM = [
  '你是结构化输出格式化器。用户会给你一段已经完成的 issue 分析文本，或完整的调查对话。',
  '把其中的结论整理成 JSON 对象，只输出对象本身，不要解释。',
  '规则：',
  '- 只使用已有证据，不要新增、不要推测、不要补写代码细节。',
  '- 缺失的字段用保守值：confidence 取 low、partial 取 true，notes 说明缺什么。',
  '- issue_summary 至少写 1 条非空事实；确实没有事实时写「原文未提供可核对的事实」。',
  '- conclusion 与 root_cause 必须有实际内容，长度不少于 10 个字符。',
].join('\n');

interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

function tokensOf(
  usage:
    | { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number }
    | undefined,
): TokenTotals {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return { input, output, total: usage?.totalTokens ?? input + output };
}

function addTokens(left: TokenTotals, right: TokenTotals): TokenTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
  };
}

interface FormatAnswerOptions {
  readonly model: LanguageModel;
  readonly temperature?: number;
  readonly abortSignal?: AbortSignal;
  /** 文本路径：把这段文本收敛成对象。 */
  readonly source?: string;
  /** 消息路径：探索阶段没有正文时，直接用完整的工具历史续写。 */
  readonly messages?: readonly ModelMessage[];
}

/**
 * 把证据收敛成 `Answer`：一次请求，**不带 tools**，带 `response_format`。
 *
 * 之所以敢在这里用 `Output.object`：没有 tools 时网关不会出现「丢弃 tool_calls」的问题，
 * 而 `response_format` 正是这一阶段需要的能力。
 */
async function formatAnswer(
  options: FormatAnswerOptions,
): Promise<{ readonly answer: Answer; readonly tokens: TokenTotals }> {
  const source = options.source?.trim();
  const messages = options.messages;
  const useMessages = messages !== undefined && messages.length > 0;

  if (!source && !useMessages) {
    throw new AgentError('探索阶段没有产出可用于格式化的文本');
  }

  let result;
  try {
    result = await generateText({
      model: options.model,
      system: FORMATTER_SYSTEM,
      ...(useMessages
        ? { messages: [...messages] }
        : { prompt: (source ?? '').slice(0, 60_000) }),
      output: Output.object({ schema: AnswerSchema }),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  } catch (error) {
    const failure = structuredOutputFailure(error);
    if (failure) {
      const recovered = recoverFromText(failure.text, AnswerSchema);
      if (recovered) {
        return { answer: recovered, tokens: tokensOf(failure.usage) };
      }
      throw new AgentError(describeStructuredOutputFailure(error));
    }
    throw toModelError(error);
  }

  const answer = result.output;
  if (!answer) {
    throw new AgentError('格式化阶段没有产出结构化结论');
  }
  return { answer, tokens: tokensOf(result.usage) };
}
