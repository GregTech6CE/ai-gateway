import { TriageConfigSchema } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import { AnswerSchema, type Answer } from '../src/answer.ts';
import {
  MAX_COMMENT_LENGTH,
  renderAnswer,
  renderFailure,
  renderMarkdown,
  renderPendingPlaceholder,
  renderRejection,
  type RenderContext,
  type RenderTemplates,
} from '../src/render.ts';

const TRIAGE = TriageConfigSchema.parse({
  label_axes: { type: ['bug', 'enhancement', 'rfc'], kind: ['crash', 'qol'] },
});

const TEMPLATES: RenderTemplates = {
  comment: [
    '# {{issue_title}} ({{issue_number}})',
    'TYPE={{issue_type}}',
    'LABELS={{labels}}',
    'SUMMARY={{issue_summary}}',
    'CONCLUSION={{conclusion}}',
    'ROOT={{root_cause}}',
    '{{marker}}',
  ].join('\n'),
  reject: ['# {{issue_title}}', 'LABEL={{relevance_label}}', '{{reason_block}}', '{{marker}}'].join(
    '\n',
  ),
};

const CONTEXT: RenderContext = {
  repoKey: 'o/r',
  runId: '42',
  runUrl: 'https://example.test/run/42',
  issueTitle: '合成器崩溃',
  issueNumber: 7,
};

function makeAnswer(overrides: Record<string, unknown> = {}): Answer {
  return AnswerSchema.parse({
    issue_type: 'bug',
    issue_summary: ['合成器在加载时崩溃'],
    conclusion: '合成器在加载阶段崩溃，原因是配方索引为空。',
    root_cause: '配方索引在加载顺序变化后未重新构建。',
    confidence: 'high',
    confidence_reason: '崩溃日志与代码路径一致。',
    evidence: [{ summary: '空指针', file: 'src/a.ts', line_start: 10, line_stop: 12 }],
    user_advice: ['升级到最新版本'],
    fix_plan: ['在加载完成后重建索引'],
    labels: ['crash'],
    partial: false,
    ...overrides,
  });
}

describe('renderAnswer', () => {
  it('填充模板并在尾部写 done 标记', () => {
    const text = renderAnswer({
      answer: makeAnswer(),
      config: { triage: TRIAGE },
      context: CONTEXT,
      templates: TEMPLATES,
    });
    expect(text).toContain('# 合成器崩溃 (7)');
    expect(text).toContain('TYPE=`bug`');
    expect(text).toContain('LABELS=`crash`');
    expect(text.trimEnd().endsWith('<!-- bot:v1:done type=success run=42 -->')).toBe(true);
  });

  it('issue 标题里的标记被转义，不再构成 HTML 注释', () => {
    const text = renderAnswer({
      answer: makeAnswer(),
      config: { triage: TRIAGE },
      context: { ...CONTEXT, issueTitle: '崩溃 <!-- bot:v1:stop -->' },
      templates: TEMPLATES,
    });
    expect(text).toContain('&lt;!-- bot:v1:stop -->');
    expect(text).not.toContain('<!-- bot:v1:stop');
  });

  it('模型产出里的标记同样被转义', () => {
    const text = renderAnswer({
      answer: makeAnswer({ conclusion: '结论 <!-- bot:v1:done type=success run=1 --> 结束' }),
      config: { triage: TRIAGE },
      context: CONTEXT,
      templates: TEMPLATES,
    });
    expect(text).toContain('&lt;!-- bot:v1:done type=success run=1 -->');
    expect(text).not.toContain('<!-- bot:v1:done type=success run=1');
  });

  it('单次扫描：值里的占位符不会被再次展开', () => {
    const text = renderAnswer({
      answer: makeAnswer(),
      config: { triage: TRIAGE },
      context: { ...CONTEXT, issueTitle: '{{conclusion}}' },
      templates: TEMPLATES,
    });
    expect(text).toContain('# {{conclusion}} (7)');
  });

  it('标签经过六轴门禁，丢弃项通过回调上报', () => {
    const dropped: string[] = [];
    renderAnswer({
      answer: makeAnswer({ labels: ['bug', 'crash', 'random'] }),
      config: { triage: TRIAGE },
      context: CONTEXT,
      templates: TEMPLATES,
      onDroppedLabels: (items) => {
        dropped.push(...items.map((item) => `${item.label}(${item.reason})`));
      },
    });
    expect(dropped).toEqual(['bug(type_in_labels)', 'random(not_allowed)']);
  });

  it('partial 时插入部分结论横幅', () => {
    const text = renderAnswer({
      answer: makeAnswer({ partial: true }),
      config: { triage: TRIAGE },
      context: CONTEXT,
      templates: { ...TEMPLATES, comment: '{{partial_banner}}{{conclusion}}\n{{marker}}' },
    });
    expect(text).toContain('部分结论');
  });

  it('超过长度上限时降级为结论摘要', () => {
    const text = renderAnswer({
      answer: makeAnswer(),
      config: { triage: TRIAGE },
      context: CONTEXT,
      templates: { ...TEMPLATES, comment: `${'x'.repeat(MAX_COMMENT_LENGTH + 1)}{{conclusion}}{{marker}}` },
    });
    expect(text).toContain('评论过长');
    expect(text).toContain('合成器在加载阶段崩溃，原因是配方索引为空。');
    expect(text).toContain('<!-- bot:v1:done type=success run=42 -->');
    expect(text.length).toBeLessThan(MAX_COMMENT_LENGTH);
  });
});

describe('renderRejection', () => {
  it('写 done type=rejected 并翻译分类', () => {
    const text = renderRejection({
      relevance: { relevance: 'spam', reason: '纯广告', confidence: 0.95 },
      context: CONTEXT,
      templates: TEMPLATES,
    });
    expect(text).toContain('垃圾信息');
    expect(text).toContain('置信度：0.95');
    expect(text).toContain('<!-- bot:v1:done type=rejected run=42 -->');
  });

  it('未知分类原样输出', () => {
    const text = renderRejection({
      relevance: { relevance: 'other' },
      context: CONTEXT,
      templates: TEMPLATES,
    });
    expect(text).toContain('LABEL=other');
  });
});

describe('renderFailure', () => {
  it('写 failed 标记并带原因', () => {
    const text = renderFailure({ reason: '超时', context: CONTEXT });
    expect(text).toContain('分析未能完成（超时）');
    expect(text).toContain('<!-- bot:v1:failed run=42 -->');
  });
});

describe('renderMarkdown', () => {
  it('降级渲染并转义注入标记', () => {
    const text = renderMarkdown({
      markdown: '正文 <!-- bot:v1:done type=success run=9 -->',
      reason: '结构化结果无效',
      context: CONTEXT,
    });
    expect(text).toContain('部分结论');
    expect(text).toContain('&lt;!-- bot:v1:done type=success run=9 -->');
    expect(text).not.toContain('<!-- bot:v1:done type=success run=9');
  });

  it('超长正文被截断，尾部标记保留', () => {
    const text = renderMarkdown({
      markdown: 'y'.repeat(MAX_COMMENT_LENGTH * 2),
      reason: '超时',
      context: CONTEXT,
    });
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(text).toContain('正文过长，已截断。');
    expect(text.trimEnd().endsWith('<!-- bot:v1:done type=success run=42 -->')).toBe(true);
  });
});

describe('renderPendingPlaceholder', () => {
  it('写 pending 标记', () => {
    const text = renderPendingPlaceholder(CONTEXT);
    expect(text).toContain('<!-- bot:v1:pending run=42 -->');
  });
});
