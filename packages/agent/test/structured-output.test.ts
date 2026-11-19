/**
 * 结构化输出的集成测试：用本地 OpenAI 兼容假 provider 触发真实的
 * `NoObjectGeneratedError`，验证三件事。
 *
 * 1. `createChatModel` 是否把 `supportsStructuredOutputs` 真正传给了 provider
 *    （表现是请求体里有没有 `response_format.json_schema`）；
 * 2. `analyzeIssue` / `draftIssue` 能否从错误携带的原文里兜底解析出对象；
 * 3. 解析不出来时抛 `AgentError`，而不是 `ModelError('network')`。
 *
 * 不用 `vi.mock('ai')`：本文件要覆盖的正是 SDK 的真实行为，打桩就测不到。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

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

interface Captured {
  readonly body: Record<string, unknown>;
}

interface Harness {
  readonly baseUrl: string;
  readonly captured: Captured[];
  readonly count: number;
  close(): Promise<void>;
}

/** 起一个只回一条 assistant 文本的 Chat Completions 假服务。 */
async function startProvider(content: (body: Record<string, unknown>) => string): Promise<Harness> {
  const captured: Captured[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      captured.push({ body });
      const text = content(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
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

async function provider(content: (body: Record<string, unknown>) => string): Promise<Harness> {
  const harness = await startProvider(content);
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

const EMPTY_TOOLS = {} as Record<string, never>;

describe('createChatModel 的 structured outputs 开关', () => {
  it('默认开启：请求体带 json_schema 形式的 response_format', async () => {
    const harness = await provider(() => JSON.stringify(ANSWER));
    const model = modelFor(harness);

    await analyzeIssue({
      model,
      prompt: { system: 's', user: 'u' },
      tools: EMPTY_TOOLS,
    });

    const body = harness.captured[0]?.body as { response_format?: { type?: string } };
    expect(body.response_format?.type).toBe('json_schema');
  });

  it('显式关闭：退化为 schema-less 的 json_object，不再下发 json_schema', async () => {
    const harness = await provider(() => JSON.stringify(ANSWER));
    const model = modelFor(harness, false);

    await analyzeIssue({
      model,
      prompt: { system: 's', user: 'u' },
      tools: EMPTY_TOOLS,
    });

    // 关闭后 SDK 只要求「输出是 JSON」，不传 schema —— 正是模型改用自由文本作答、
    // 进而触发 NoObjectGeneratedError 的前提。这也是该开关只在网关确实不支持时才关的原因。
    const body = harness.captured[0]?.body as { response_format?: { type?: string } };
    expect(body.response_format?.type).toBe('json_object');
  });
});

describe('analyzeIssue 的结构化输出兜底', () => {
  it('模型把 JSON 包在说明文字里时，用错误携带的原文兜底解析', async () => {
    // schema 未生效时模型常这样作答：先一句人话，再贴 JSON。
    const harness = await provider(() => `我已经完成调查。\n${JSON.stringify(ANSWER)}`);

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u', profile: 'gregtech6' },
      tools: EMPTY_TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(outcome.answer.labels).toEqual(['crash']);
    // 兜底路径拿不到步数，如实写 0；正常路径不会出现 0。
    expect(outcome.steps).toBe(0);
    expect(outcome.tokens.total).toBe(18);
    expect(outcome.finishReason).toBe('stop');
  });

  it('纯散文无法解析时抛 AgentError，而不是 network 的 ModelError', async () => {
    const harness = await provider(() => '我先看一下代码，稍后再给结论。');

    const failure = analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: EMPTY_TOOLS,
    });

    await expect(failure).rejects.toBeInstanceOf(AgentError);
    await expect(failure).rejects.toMatchObject({ name: 'AgentError' });
    // 只有一次请求：AgentError 不会触发 SDK 或调用方的重试。
    expect(harness.count).toBe(1);
  });

  it('单键包裹（{"answer": {...}}）也能解包恢复', async () => {
    // 不少模型会把结果再包一层；只在包内对象能通过 schema 时才解包。
    const harness = await provider(() => JSON.stringify({ answer: ANSWER }));

    const outcome = await analyzeIssue({
      model: modelFor(harness),
      prompt: { system: 's', user: 'u' },
      tools: EMPTY_TOOLS,
    });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(outcome.steps).toBe(0);
  });

  it('JSON 合法但不符合 schema 时，失败原因带字段路径', async () => {
    // 关闭 structuredOutputs 时模型可能自行编一个形状；这里模拟这种「能解析、不合格」。
    const harness = await provider(() => JSON.stringify({ foo: 'bar' }));

    const failure = analyzeIssue({
      model: modelFor(harness, false),
      prompt: { system: 's', user: 'u' },
      tools: EMPTY_TOOLS,
    });

    await expect(failure).rejects.toBeInstanceOf(AgentError);
    // 摘要里给出 zod 的字段路径，便于直接判断是缺字段还是多了字段；不含模型正文。
    await expect(failure).rejects.toThrow(/issue_type|Unrecognized key/);
    // 同时给出形状摘要（键名与类型），不含任何内容。
    await expect(failure).rejects.toThrow(/keys=\[foo\]/);
    expect(harness.count).toBe(1);
  });
});

describe('draftIssue 的结构化输出兜底', () => {
  it('从说明文字中兜底解析出草稿', async () => {
    const harness = await provider(() => `整理结果如下：\n${JSON.stringify(DRAFT)}`);

    const draft = await draftIssue({
      model: modelFor(harness),
      system: 's',
      user: 'u',
    });

    expect(draft).toEqual(DRAFT);
  });

  it('无法解析时抛 AgentError', async () => {
    const harness = await provider(() => '这个 issue 看起来是崩溃。');

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
    const harness = await provider(() =>
      JSON.stringify({ relevance: 'in_scope', confidence: 0.9, reason: '缺陷报告' }),
    );

    const verdict = await classifyRelevance({
      model: modelFor(harness, false),
      prompt: { system: 's', user: 'u' },
    });

    expect(verdict).toMatchObject({ relevance: 'in_scope', confidence: 0.9 });
    // 轻量分类不传 tools、也不要 response_format。
    const body = harness.captured[0]?.body as { response_format?: unknown };
    expect(body.response_format).toBeUndefined();
  });
});
