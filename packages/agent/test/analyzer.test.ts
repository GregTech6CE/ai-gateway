import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: (options: unknown) => ({ mode: 'object', options }) },
  stepCountIs: (count: number) => ({ kind: 'steps', count }),
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
  it('返回结构化结论与用量', async () => {
    mocks.generateText.mockResolvedValue({
      output: ANSWER,
      steps: [{}, {}],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      text: 'done',
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
    expect(call.output).toMatchObject({ mode: 'object' });
    expect(call.stopWhen).toBeDefined();
  });

  it('模型没有产出结构化结论时抛 AgentError', async () => {
    mocks.generateText.mockResolvedValue({
      output: undefined,
      steps: [{}],
      usage: {},
      text: 'plain',
      finishReason: 'stop',
    });
    await expect(analyzeIssue({ model: MODEL, prompt: PROMPT, tools: {} })).rejects.toBeInstanceOf(
      AgentError,
    );
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
      });
      return {
        output: ANSWER,
        steps: [{}],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        text: '',
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
