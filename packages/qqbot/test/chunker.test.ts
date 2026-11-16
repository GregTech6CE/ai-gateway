import { describe, expect, it } from 'vitest';

import { splitMessage } from '../src/chunker.ts';

describe('splitMessage', () => {
  it('空内容返回空数组，短内容原样返回', () => {
    expect(splitMessage('')).toEqual([]);
    expect(splitMessage('   \n\n  ')).toEqual([]);
    expect(splitMessage('## 标题\n\n正文')).toEqual(['## 标题\n\n正文']);
    expect(splitMessage('a\r\nb')).toEqual(['a\nb']);
  });

  it('maxLength 非法时抛错', () => {
    expect(() => splitMessage('x', { maxLength: 10 })).toThrowError(RangeError);
    expect(() => splitMessage('x', { maxLength: 300.5 })).toThrowError(RangeError);
  });

  it('超长段落按行装箱，每片都不超过上限', () => {
    const lines = Array.from({ length: 120 }, (_, index) => `第 ${index} 行：这是一段用于测试切分的普通文本。`);
    const chunks = splitMessage(lines.join('\n'), { maxLength: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect(chunk.startsWith('\n')).toBe(false);
      expect(chunk.endsWith('\n')).toBe(false);
    }
    // 行不丢、不重复、顺序不变。
    expect(chunks.flatMap((chunk) => chunk.split('\n'))).toEqual(lines);
  });

  it('切分不破坏代码围栏：每片自带完整围栏且代码行不丢', () => {
    const body = Array.from({ length: 90 }, (_, index) => `const value${index} = ${index}; // 填充填充填充`);
    const chunks = splitMessage(['```ts', ...body, '```'].join('\n'), { maxLength: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      expect(lines[0]).toBe('```ts');
      expect(lines[lines.length - 1]).toBe('```');
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
    const rebuilt = chunks.flatMap((chunk) => chunk.split('\n').slice(1, -1));
    expect(rebuilt).toEqual(body);
  });

  it('未闭合的围栏也按代码块处理并补上闭合', () => {
    const body = Array.from({ length: 60 }, (_, index) => `println(${index}) // 注释注释注释`);
    const chunks = splitMessage(['```', ...body].join('\n'), { maxLength: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith('```')).toBe(true);
      expect(chunk.endsWith('```')).toBe(true);
    }
  });

  it('切分表格时重复表头与分隔行', () => {
    const header = '| 字段 | 说明 |';
    const separator = '| --- | --- |';
    const rows = Array.from({ length: 60 }, (_, index) => `| row${index} | 说明说明说明说明说明说明 |`);
    const chunks = splitMessage([header, separator, ...rows].join('\n'), { maxLength: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      expect(lines[0]).toBe(header);
      expect(lines[1]).toBe(separator);
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
    expect(chunks.flatMap((chunk) => chunk.split('\n').slice(2))).toEqual(rows);
  });

  it('超长单行按码点切开，不产生半个字符', () => {
    const line = '😀'.repeat(400);
    const chunks = splitMessage(line, { maxLength: 250 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(250);
      expect(chunk.includes('\uFFFD')).toBe(false);
    }
    expect(chunks.join('')).toBe(line);
  });

  it('段落与代码块混排时保持边界', () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `段落 ${index}：${'内容'.repeat(30)}`);
    const content = [
      '# 结论',
      '',
      ...paragraphs,
      '',
      '```python',
      ...Array.from({ length: 40 }, (_, index) => `print(${index})`),
      '```',
      '',
      '末尾说明',
    ].join('\n');
    const chunks = splitMessage(content, { maxLength: 500 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    const joined = chunks.join('\n');
    expect(joined).toContain('# 结论');
    expect(joined).toContain('末尾说明');
    // 代码内容完整：按顺序出现且没有重复。
    const codeLines = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('print('));
    expect(codeLines).toEqual(Array.from({ length: 40 }, (_, index) => `print(${index})`));
  });
});
