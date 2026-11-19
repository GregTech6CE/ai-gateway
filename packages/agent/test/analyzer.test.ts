import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: (options: unknown) => ({ mode: 'object', options }) },
  stepCountIs: (count: number) => ({ kind: 'steps', count }),
  // 结构化输出错误由 output-errors.ts 引用；本文件用鸭子类型构造，这里只提供占位，
  // 避免 vite 的 mock 代理在解构缺失导出时抛错。
  NoObjectGeneratedError: { isInstance: () => false },
  JSONParseError: { isInstance: () => false },
}));

const { AgentError, analyzeIssue, classifyRelevance } = await import('../src/analyzer.ts');
const { ModelError } = await import('../src/model-pool.ts');

const MODEL = {} as LanguageModel;

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

const PROMPT = { system: 'system', user: 'user', profile: 'gregtech6' };

beforeEach(() => {
  mocks.generateText.mockReset();
});

describe('classifyRelevance', () => {
  it('解析 JSON 并夹紧置信度', async () => {
    mocks.generateText.mockResolvedValue({
      text: '```json\n{"relevance":"spam","confidence":1.7,"reason":"广告","evidence":["x"]}\n```',
    });
    const verdict = await classifyRelevance({ model: MODEL, prompt: PROMPT });
    expect(verdict).toEqual({
      relevance: 'spam',
      confidence: 1,
      reason: '广告',
      evidence: ['x'],
    });
  });

  it('无法解析时返回 undefined，不抛错', async () => {
    mocks.generateText.mockResolvedValue({ text: '我不知道' });
    await expect(classifyRelevance({ model: MODEL, prompt: PROMPT })).resolves.toBeUndefined();
  });

  it('类别非法时返回 undefined', async () => {
    mocks.generateText.mockResolvedValue({ text: '{"relevance":"maybe","confidence":0.9}' });
    await expect(classifyRelevance({ model: MODEL, prompt: PROMPT })).resolves.toBeUndefined();
  });

  it('传输层错误转成可判定的 ModelError', async () => {
    mocks.generateText.mockRejectedValue({
      statusCode: 429,
      responseHeaders: { 'retry-after': '30' },
      message: 'rate limited',
    });
    await expect(classifyRelevance({ model: MODEL, prompt: PROMPT })).rejects.toMatchObject({
      kind: 'rate',
      status: 429,
      retryAfterSeconds: 30,
    });
  });
});

describe('analyzeIssue', () => {
  it('探索阶段不传 output，直接解析最终文本并保留真实步数', async () => {
    mocks.generateText.mockResolvedValue({
      steps: [{}, {}],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      text: JSON.stringify(ANSWER),
      finishReason: 'stop',
    });

    const outcome = await analyzeIssue({ model: MODEL, prompt: PROMPT, tools: {} });

    expect(outcome.answer.issue_type).toBe('bug');
    expect(outcome.steps).toBe(2);
    expect(outcome.tokens).toEqual({ input: 10, output: 20, total: 30 });
    expect(outcome.profile).toBe('gregtech6');
    expect(outcome.finishReason).toBe('stop');

    const call = mocks.generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.model).toBe(MODEL);
    expect(call.system).toBe('system');
    expect(call.stopWhen).toBeDefined();
    // 未传 maxSteps 时不按步数截断：stopWhen 恒为 false，循环靠自然停止/软着陆结束。
    expect(typeof call.stopWhen).toBe('function');
    expect((call.stopWhen as (options: unknown) => boolean)({ steps: [] })).toBe(false);
    expect(call.prepareStep).toBeDefined();
    // 关键：探索阶段的请求体不能出现 output（它会变成 response_format，
    // 进而让部分网关丢弃 tool_calls）。
    expect(call.output).toBeUndefined();
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it('散文收尾时发起一次无 tools 的格式化请求，并累加 token', async () => {
    mocks.generateText
      .mockResolvedValueOnce({
        steps: [{}, {}, {}],
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        text: '我先读了 README，结论是配方索引为空。',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        output: ANSWER,
        steps: [{}],
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        text: '',
        finishReason: 'stop',
      });

    const outcome = await analyzeIssue({ model: MODEL, prompt: PROMPT, tools: {} });

    expect(outcome.answer.issue_type).toBe('bug');
    // steps 只统计探索阶段。
    expect(outcome.steps).toBe(3);
    expect(outcome.tokens).toEqual({ input: 130, output: 50, total: 180 });

    const formatter = mocks.generateText.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(formatter.tools).toBeUndefined();
    expect(formatter.output).toMatchObject({ mode: 'object' });
    expect(String(formatter.system)).toContain('格式化');
    expect(formatter.prompt).toBe('我先读了 README，结论是配方索引为空。');
  });

  it('两阶段都无法产出合法 Answer 时抛 AgentError，并带上真实 steps 与 tokens', async () => {
    mocks.generateText
      .mockResolvedValueOnce({
        steps: [{}, {}, {}],
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        text: 'plain',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        output: undefined,
        steps: [{}],
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        text: 'still plain',
        finishReason: 'stop',
      });

    const failure = analyzeIssue({ model: MODEL, prompt: PROMPT, tools: {} });

    await expect(failure).rejects.toBeInstanceOf(AgentError);
    await expect(failure).rejects.not.toMatchObject({ kind: 'network' });
    // 1 次探索 + 1 次格式化，不会重试。
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    // 失败路径必须带上真实消耗：以前这里恒为 0，把「跑了 3 步」记成了 0。
    await expect(failure).rejects.toMatchObject({ steps: 3, tokens: 140 });
  });

  it('上游 5xx 转成 upstream 错误', async () => {
    mocks.generateText.mockRejectedValue({ statusCode: 503, message: 'unavailable' });
    await expect(analyzeIssue({ model: MODEL, prompt: PROMPT, tools: {} })).rejects.toMatchObject({
      kind: 'upstream',
      status: 503,
    });
  });

  it('步骤回调拿到脱敏后的文本与工具名', async () => {
    const onStep = vi.fn();
    mocks.generateText.mockImplementation(async (options: Record<string, unknown>) => {
      const handler = options.onStepFinish as (step: unknown) => void;
      handler({
        stepNumber: 0,
        text: 'sk-abcdefghijklmnop1234',
        toolCalls: [{ toolName: 'read_file', input: { path: 'a.ts' } }],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      });
      return {
        steps: [{}],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        text: JSON.stringify(ANSWER),
        finishReason: 'stop',
      };
    });

    await analyzeIssue({ model: MODEL, prompt: PROMPT, tools: {}, onStep });
    expect(onStep).toHaveBeenCalledTimes(1);
    const step = onStep.mock.calls[0]?.[0] as {
      text: string;
      toolCalls: Array<{ name: string }>;
    };
    expect(step.text).not.toContain('sk-abcdefghijklmnop1234');
    expect(step.toolCalls[0]?.name).toBe('read_file');
  });
});

describe('ModelError', () => {
  it('保留 kind 与状态码', () => {
    const error = new ModelError('auth', 401, 0, 'bad key');
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(401);
  });
});
