/**
 * 两阶段分析器的集成测试：用本地 OpenAI 兼容假 provider 走真实的 AI SDK 路径。
 *
 * 覆盖的核心约束（来自 `api.cline.bot` 的实测行为）：
 * 请求里一旦同时出现 `tools` 与 `response_format`，网关就不再填充 `message.tool_calls`，
 * 而是把工具调用塞进 `message.content`。因此：
 *
 * 1. 探索阶段只传 `tools`，绝不传 `output`（不产生 `response_format`）；
 * 2. 探索结束后先直接从最终文本解析 `Answer`（零额外请求）；
 * 3. 解析不出来时，再用一次不带 `tools` 的请求做格式化。
 *
 * 不用 `vi.mock('ai')`：本文件要覆盖的正是 SDK 的真实请求与工具循环行为。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { tool } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentError, analyzeIssue, createChatModel, classifyRelevance } from '../src/analyzer.ts';
import { draftIssue } from '../src/draft.ts';
import { toModelError } from '../src/model-pool.ts';
import { isStructuredOutputError } from '../src/output-errors.ts';

// 本文件故意覆盖「关闭 structuredOutputs」的分支，AI SDK 会向 stderr 打
// `unsupported responseFormat` 告警；Rush 把「成功但有告警」判成非零退出码，
// 因此在这里显式静音（SDK 在每次告警时读取该全局变量）。
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const ANSWER = {
  issue_type: 'bug',
  issue_summary: ['合成器在加载时崩溃'],
  conclusion: '合成器在加载阶段崩溃，原因是配方索引为空。',
  root_cause: '配方索引在加载顺序变化后未重新构建。',
  confidence: 'high',
  confidence_reason: '崩溃日志与代码路径一致。',
  evidence: [{ summary: '空指针', file: 'src/a.ts', line_start: 10 }],
  user_advice: ['升级到最新版本'],
  fix_plan: ['在加载完成后重建索引'],
  labels: ['crash'],
  partial: false,
};

const DRAFT = {
  title: '合成器在 1.21.1 加载配方时崩溃',
  body: '## 现象\n\n打开合成器即崩溃。',
  labels: ['bug'],
};

interface ReplyToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: string;
}

interface Reply {
  readonly content?: string | null;
  readonly toolCalls?: readonly ReplyToolCall[];
}

interface Captured {
  readonly body: Record<string, unknown>;
}

interface Harness {
  readonly baseUrl: string;
  readonly captured: Captured[];
  readonly count: number;
  close(): Promise<void>;
}

/**
 * 起一个按脚本回复的 Chat Completions 假服务。
 *
 * 脚本按请求序号消费；超出长度后重复最后一条，保证意外的额外请求不会静默通过。
 */
async function startProvider(
  script: readonly Reply[] | ((body: Record<string, unknown>, index: number) => Reply),
): Promise<Harness> {
  const captured: Captured[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const index = captured.length;
      captured.push({ body });
      const reply =
        typeof script === 'function'
          ? script(body, index)
          : (script[Math.min(index, script.length - 1)] ?? { content: '' });

      const toolCalls = reply.toolCalls ?? [];
      const message = {
        role: 'assistant',
        content: reply.content ?? null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.args },
              })),
            }
          : {}),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-test-${index}`,
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message,
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
    });
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    captured,
    get count() {
      return captured.length;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const open: Harness[] = [];

async function provider(
  script: readonly Reply[] | ((body: Record<string, unknown>, index: number) => Reply),
): Promise<Harness> {
  const harness = await startProvider(script);
  open.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

function modelFor(harness: Harness, supportsStructuredOutputs?: boolean) {
  return createChatModel({
    baseUrl: harness.baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    providerName: 'test',
    ...(supportsStructuredOutputs !== undefined ? { supportsStructuredOutputs } : {}),
  });
}

/** 一个最小可执行工具，用来驱动真实的工具循环。 */
const TOOLS = {
  read_file: tool({
    description: '读取仓库中的文本文件',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => ({ path, content: 'README content' }),
  }),
};

function readCall(id: string, path: string): ReplyToolCall {
  return { id, name: 'read_file', args: JSON.stringify({ path }) };
}

const READ_CALL: ReplyToolCall = readCall('call-1', 'README.md');

describe('请求形状：tools 与 response_format 不同时出现', () => {
  it('探索阶段带 tools，但不带 response_format', async () => {
    const harness = await provider([{ content: JSON.stringify(ANSWER) }]);

    await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    const body = harness.captured[0]?.body as {
      tools?: unknown;
      response_format?: unknown;
    };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.response_format).toBeUndefined();
    // 直接解析成功，不该有第二次请求。
    expect(harness.count).toBe(1);
  });

  it('格式化阶段不带 tools，且使用 json_schema', async () => {
    const harness = await provider([
      { content: '我读了 README，结论是配方索引为空。' },
      { content: JSON.stringify(ANSWER) },
    ]);

    await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    const formatter = harness.captured[1]?.body as {
      tools?: unknown;
      response_format?: { type?: string };
    };
    expect(formatter.tools).toBeUndefined();
    expect(formatter.response_format?.type).toBe('json_schema');
  });

  it('关闭 structuredOutputs 时，格式化请求退化为 schema-less 的 json_object', async () => {
    const harness = await provider([
      { content: '我读了 README，结论是配方索引为空。' },
      { content: JSON.stringify(ANSWER) },
    ]);

    await analyzeIssue({
      model: modelFor(harness, false),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    const formatter = harness.captured[1]?.body as { response_format?: { type?: string } };
    expect(formatter.response_format?.type).toBe('json_object');
  });
});

describe('两阶段行为', () => {
  it('工具调用后直接给出合法 JSON：零额外请求，steps > 0', async () => {
    const harness = await provider([
      { toolCalls: [READ_CALL] },
      { content: JSON.stringify(ANSWER) },
    ]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u', profile: 'gregtech6' },
      tools: TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    // 一次工具调用 + 一次最终回答 = 2 步。
    expect(outcome.steps).toBe(2);
    expect(outcome.tokens.total).toBe(36);
    // 两次请求都带 tools，都不带 response_format。
    expect(harness.count).toBe(2);
    for (const item of harness.captured) {
      const body = item.body as { tools?: unknown; response_format?: unknown };
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.response_format).toBeUndefined();
    }
  });

  it('工具调用后用散文收尾：触发 1 次格式化请求并返回合法 Answer', async () => {
    const harness = await provider([
      { toolCalls: [READ_CALL] },
      { content: '我先看了 README。结论：配方索引在加载顺序变化后没有重建。' },
      { content: JSON.stringify(ANSWER) },
    ]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    // steps 只统计探索阶段（工具调用 + 散文收尾）。
    expect(outcome.steps).toBe(2);
    expect(harness.count).toBe(3);
    const formatter = harness.captured[2]?.body as { tools?: unknown };
    expect(formatter.tools).toBeUndefined();
  });

  it('两阶段都无法产出合法 Answer 时抛 AgentError，且携带真实 steps/tokens', async () => {
    const harness = await provider([
      { toolCalls: [READ_CALL] },
      { content: '我先看了 README，还没形成结论。' },
      { content: '仍然是散文，没有 JSON。' },
    ]);

    const failure = analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    await expect(failure).rejects.toBeInstanceOf(AgentError);
    // 关键：失败也要带出「跑了 2 步、烧了 36 token」，而不是 0。
    await expect(failure).rejects.toMatchObject({ steps: 2, tokens: 36 });
    // 1 次探索 + 1 次工具后续 + 1 次格式化，没有重试。
    expect(harness.count).toBe(3);
  });
});

describe('无步数上限与软着陆', () => {
  it('不传 maxSteps 时可以连续执行超过 60 步，直到模型自然结束', async () => {
    // 61 次不同路径的工具调用 + 1 次最终回答：若仍存在 60 步硬上限，这里会失败。
    const script: Reply[] = [];
    for (let index = 0; index < 61; index += 1) {
      script.push({ toolCalls: [readCall(`call-${index}`, `file-${index}.md`)] });
    }
    script.push({ content: JSON.stringify(ANSWER) });

    const harness = await provider(script);
    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    expect(outcome.steps).toBe(62);
    expect(harness.count).toBe(62);
    expect(outcome.answer.issue_type).toBe('bug');
  });

  it('连续重复工具调用达到阈值时，下一步禁用工具并软着陆', async () => {
    const harness = await provider([
      { toolCalls: [readCall('call-1', 'README.md')] },
      { toolCalls: [readCall('call-2', 'README.md')] },
      { toolCalls: [readCall('call-3', 'README.md')] },
      { content: JSON.stringify(ANSWER) },
    ]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
      loopRepeatThreshold: 3,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(outcome.steps).toBe(4);
    // 第 4 次请求（index 3）应当没有工具，且带上收尾指令。
    const wrapUp = harness.captured[3]?.body as {
      tools?: unknown;
      tool_choice?: unknown;
      messages?: unknown;
    };
    // tools 被清空（provider 在无工具时不会发送 tool_choice，只能断言「没有工具 + 有指令」）。
    expect(wrapUp.tools ?? []).toEqual([]);
    expect(JSON.stringify(wrapUp.messages)).toContain('停止调用工具');
  });

  it('softTimeoutMs 到点后同样触发软着陆', async () => {
    const harness = await provider([
      { toolCalls: [readCall('call-1', 'README.md')] },
      { content: JSON.stringify(ANSWER) },
    ]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
      softTimeoutMs: 0,
    });

    expect(outcome.steps).toBe(2);
    const second = harness.captured[1]?.body as {
      tools?: unknown;
      tool_choice?: unknown;
    };
    expect(second.tools ?? []).toEqual([]);
  });

  it('探索阶段没有正文但跑过工具时，用消息历史完成格式化', async () => {
    const harness = await provider([
      { toolCalls: [readCall('call-1', 'README.md')] },
      { content: '' },
      { content: JSON.stringify(ANSWER) },
    ]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(outcome.steps).toBe(2);

    const formatter = harness.captured[2]?.body as {
      tools?: unknown;
      response_format?: { type?: string };
      messages?: Array<{ role?: string }>;
    };
    expect(formatter.tools).toBeUndefined();
    expect(formatter.response_format?.type).toBe('json_schema');
    // 必须带上工具结果，不能只给一句空指令。
    expect(formatter.messages?.some((message) => message.role === 'tool')).toBe(true);
    expect(formatter.messages?.at(-1)?.role).toBe('user');
  });
});

describe('无工具调用时的直接解析', () => {
  it('模型把 JSON 包在说明文字里时，直接从最终文本解析（零额外请求）', async () => {
    const harness = await provider([{ content: `我已经完成调查。\n${JSON.stringify(ANSWER)}` }]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u', profile: 'gregtech6' },
      tools: TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(outcome.steps).toBe(1);
    expect(harness.count).toBe(1);
  });

  it('单键包裹（{"answer": {...}}）也能解包恢复', async () => {
    const harness = await provider([{ content: JSON.stringify({ answer: ANSWER }) }]);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(harness.count).toBe(1);
  });

  it('纯散文无法解析时，格式化一次仍失败即抛 AgentError', async () => {
    const harness = await provider([{ content: '我先看一下代码，稍后再给结论。' }]);

    const failure = analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    await expect(failure).rejects.toBeInstanceOf(AgentError);
    // 脚本复用到最后一条，因此两次都是散文。
    expect(harness.count).toBe(2);
  });

  it('JSON 合法但不符合 schema 时，失败原因带字段路径与形状摘要', async () => {
    const harness = await provider([{ content: JSON.stringify({ foo: 'bar' }) }]);

    const failure = analyzeIssue({
      model: modelFor(harness, false),
      prompt: { system: 's', user: 'u' },
      tools: TOOLS,
    });

    await expect(failure).rejects.toBeInstanceOf(AgentError);
    await expect(failure).rejects.toThrow(/issue_type|Unrecognized key/);
    await expect(failure).rejects.toThrow(/keys=\[foo\]/);
    expect(harness.count).toBe(2);
  });
});

describe('draftIssue 的结构化输出兜底', () => {
  it('从说明文字中兜底解析出草稿', async () => {
    const harness = await provider([{ content: `整理结果如下：\n${JSON.stringify(DRAFT)}` }]);

    const draft = await draftIssue({
      model: modelFor(harness),
      system: 's',
      user: 'u',
    });

    expect(draft).toEqual(DRAFT);
  });

  it('无法解析时抛 AgentError', async () => {
    const harness = await provider([{ content: '这个 issue 看起来是崩溃。' }]);

    await expect(
      draftIssue({ model: modelFor(harness), system: 's', user: 'u' }),
    ).rejects.toBeInstanceOf(AgentError);
    expect(harness.count).toBe(1);
  });
});

describe('toModelError 的防御性分类', () => {
  it('结构化输出错误归为 config，不是 network', () => {
    const error = Object.assign(new Error('no object generated'), {
      name: 'AI_NoObjectGeneratedError',
    });

    const modelError = toModelError(error);

    expect(modelError.kind).toBe('config');
    expect(modelError.status).toBe(0);
    expect(isStructuredOutputError(error)).toBe(true);
  });

  it('JSONParseError 同样归为 config', () => {
    const error = Object.assign(new Error('json parse failed'), { name: 'AI_JSONParseError' });
    expect(toModelError(error).kind).toBe('config');
  });

  it('真正的网络错误仍然是 network', () => {
    expect(toModelError(new TypeError('fetch failed')).kind).toBe('network');
  });
});

describe('classifyRelevance 不受影响', () => {
  it('纯文本分类仍然可用（没有 response_format 依赖）', async () => {
    const harness = await provider([
      { content: JSON.stringify({ relevance: 'in_scope', confidence: 0.9, reason: '缺陷报告' }) },
    ]);

    const verdict = await classifyRelevance({
      model: modelFor(harness, false),
      prompt: { system: 's', user: 'u' },
    });

    expect(verdict).toMatchObject({ relevance: 'in_scope', confidence: 0.9 });
    const body = harness.captured[0]?.body as { response_format?: unknown };
    expect(body.response_format).toBeUndefined();
  });
});
