import { TriageConfigSchema, type TriageConfig } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import { formatDropped, normalizeLabel, sanitize } from '../src/labels.ts';

const TRIAGE: TriageConfig = TriageConfigSchema.parse({
  label_axes: {
    type: ['bug', 'enhancement', 'rfc'],
    kind: ['crash', 'regression', 'perf', 'parity', 'translation', 'qol', 'balance', 'refactor'],
    scope: ['scope: recipe', 'scope: machine', 'scope: ui'],
    status: ['needs info', 'needs help'],
    priority: ['priority: low', 'priority: medium', 'priority: high'],
    version: ['1.20.1', '1.21.1'],
  },
  label_limits: { type: 1, kind: 2, scope: 2, status: 1, priority: 1, version: 1 },
  write_only: ['crash', 'scope: machine'],
  triage_labels: ['needs triage'],
});

const FALLBACK: TriageConfig = TriageConfigSchema.parse({
  write_only: ['crash', 'needs info'],
});

describe('normalizeLabel', () => {
  it('折叠空白并规范轴前缀', () => {
    expect(normalizeLabel('  scope:machine ')).toBe('scope: machine');
    expect(normalizeLabel('PRIORITY :  high')).toBe('PRIORITY: high');
    expect(normalizeLabel(null)).toBe('');
  });
});

describe('sanitize', () => {
  it('保留六轴内的合法标签', () => {
    const result = sanitize(
      ['crash', 'scope: machine', 'priority: high', '1.21.1'],
      'bug',
      TRIAGE,
    );
    expect(result.kept).toEqual(['crash', 'scope: machine', 'priority: high', '1.21.1']);
    expect(result.dropped).toEqual([]);
    expect(result.issueType).toBe('bug');
  });

  it('类型标签不重复写入 labels', () => {
    const result = sanitize(['bug', 'crash'], 'bug', TRIAGE);
    expect(result.kept).toEqual(['crash']);
    expect(result.dropped).toEqual([{ label: 'bug', reason: 'type_in_labels' }]);
  });

  it('性质标签与类型不兼容时丢弃', () => {
    const result = sanitize(['qol'], 'bug', TRIAGE);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([{ label: 'qol', reason: 'kind_not_for_bug' }]);
  });

  it('类型未知时丢弃全部性质标签', () => {
    const result = sanitize(['crash'], 'unknown', TRIAGE);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([{ label: 'crash', reason: 'kind_without_type' }]);
    expect(result.issueType).toBe('unknown');
  });

  it('类型无法识别时归为 unknown', () => {
    const result = sanitize(['crash'], 'wontfix', TRIAGE);
    expect(result.issueType).toBe('unknown');
    expect(result.dropped[0]?.reason).toBe('kind_without_type');
  });

  it('按轴丢弃超限项', () => {
    const result = sanitize(['scope: recipe', 'scope: machine', 'scope: ui'], 'bug', TRIAGE);
    expect(result.kept).toEqual(['scope: recipe', 'scope: machine']);
    expect(result.dropped).toEqual([{ label: 'scope: ui', reason: 'limit_scope' }]);
  });

  it('性质轴上限为 2', () => {
    const result = sanitize(['crash', 'perf', 'regression'], 'bug', TRIAGE);
    expect(result.kept).toEqual(['crash', 'perf']);
    expect(result.dropped).toEqual([{ label: 'regression', reason: 'limit_kind' }]);
  });

  it('丢弃白名单外的标签', () => {
    const result = sanitize(['random-label'], 'bug', TRIAGE);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([{ label: 'random-label', reason: 'not_allowed' }]);
  });

  it('归一化后去重，保留首次出现', () => {
    const result = sanitize(['CRASH', 'crash'], 'bug', TRIAGE);
    expect(result.kept).toEqual(['crash']);
    expect(result.dropped).toEqual([]);
  });

  it('没有六轴配置时回退到 write_only', () => {
    const result = sanitize(['crash', 'needs info', 'scope: machine'], 'bug', FALLBACK);
    expect(result.kept).toEqual(['crash', 'needs info']);
    expect(result.dropped).toEqual([{ label: 'scope: machine', reason: 'not_allowed' }]);
    expect(result.issueType).toBe('bug');
  });
});

describe('formatDropped', () => {
  it('输出 标签(原因) 形式', () => {
    expect(
      formatDropped([
        { label: 'qol', reason: 'kind_not_for_bug' },
        { label: 'random', reason: 'not_allowed' },
      ]),
    ).toBe('qol(kind_not_for_bug), random(not_allowed)');
  });
});
