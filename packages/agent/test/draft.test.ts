import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: (options: unknown) => ({ mode: 'object', options }) },
  stepCountIs: (count: number) => ({ kind: 'steps', count }),
}));

const { AgentError } = await import('../src/analyzer.ts');
const { draftIssue } = await import('../src/draft.ts');

const MODEL = {} as LanguageModel;
const OPTIONS = { model: MODEL, system: 'system', user: 'user' };

const DRAFT = {
  title: '合成器在 1.21.1 加载配方时崩溃',
  body: '## 现象\n\n打开合成器即崩溃。',
  labels: ['bug', 'crash'],
};

beforeEach(() => {
  mocks.generateText.mockReset();
});

describe('draftIssue', () => {
  it('返回通过 schema 的草稿', async () => {
    mocks.generateText.mockResolvedValue({ output: DRAFT });

    await expect(draftIssue(OPTIONS)).resolves.toEqual(DRAFT);

    const call = mocks.generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.system).toBe('system');
    expect(call.prompt).toBe('user');
    expect(call.output).toMatchObject({ mode: 'object' });
  });

  it('tags 缺省时补空数组（schema 默认值）', async () => {
    mocks.generateText.mockResolvedValue({
      output: { title: '标题', body: '正文' },
    });

    const draft = await draftIssue(OPTIONS);
    expect(draft.labels).toEqual([]);
  });

  it('没有结构化输出时抛 AgentError', async () => {
    mocks.generateText.mockResolvedValue({ output: undefined });

    await expect(draftIssue(OPTIONS)).rejects.toBeInstanceOf(AgentError);
  });

  it('传输层错误归一化为 ModelError', async () => {
    mocks.generateText.mockRejectedValue({
      statusCode: 429,
      responseHeaders: { 'retry-after': '12' },
      message: 'rate limited',
    });

    await expect(draftIssue(OPTIONS)).rejects.toMatchObject({
      kind: 'rate',
      status: 429,
      retryAfterSeconds: 12,
    });
  });

  it('透传温度与输出上限', async () => {
    mocks.generateText.mockResolvedValue({ output: DRAFT });

    await draftIssue({ ...OPTIONS, temperature: 0.2, maxOutputTokens: 2048 });

    const call = mocks.generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.2);
    expect(call.maxOutputTokens).toBe(2048);
  });
});
