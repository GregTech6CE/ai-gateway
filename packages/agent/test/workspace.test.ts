import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WorkspaceError,
  buildManifest,
  buildLogDigest,
  extractZip,
  formField,
  resolveVersionTag,
  versionBase,
  versionCandidates,
} from '../src/workspace.ts';

/** 构造一个 stored（不压缩）zip，足够覆盖中央目录解析与边界防护。 */
function makeZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const LIMITS = { maxAttachmentBytes: 1024, maxTotalAttachmentBytes: 4096 };

describe('版本 ref', () => {
  const body = ['### 模组版本 / Mod version', '', 'v1.21.1', '', '### 描述', '', '崩溃'].join('\n');

  it('读取表单字段并去掉 v 前缀', () => {
    expect(formField(body, ['模组版本 / Mod version'])).toBe('v1.21.1');
    expect(versionBase(body)).toBe('1.21.1');
  });

  it('候选 tag 由模板生成并去重', () => {
    expect(versionCandidates('1.21.1', { tag_template: 'v{version}' })).toEqual([
      'v1.21.1',
      '1.21.1',
    ]);
    expect(versionCandidates('1.21.1', { code_ref_mode: 'branch' })).toEqual([]);
  });

  it('解析命中的 tag，未命中返回空串', () => {
    const tags = new Set(['v1.21.1']);
    expect(resolveVersionTag('1.21.1', tags, {})).toBe('v1.21.1');
    expect(resolveVersionTag('1.20.1', tags, {})).toBe('');
    expect(resolveVersionTag('1.21.1', undefined, {})).toBe('');
  });
});

describe('代码清单', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gt6ce-manifest-'));
    mkdirSync(join(root, 'code', 'current', 'src'), { recursive: true });
    mkdirSync(join(root, 'code', 'golden', 'src'), { recursive: true });
    mkdirSync(join(root, 'code', 'v1.0', 'src'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'code', 'current', 'src', 'A.java'), 'class A {}\n');
    writeFileSync(join(root, 'code', 'golden', 'src', 'B.java'), 'class B {}\n');
    writeFileSync(join(root, 'code', 'v1.0', 'src', 'A.java'), 'class A {}\n');
    writeFileSync(join(root, 'docs', 'aux.md'), '# aux\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('清点 gt6ce/golden/history/auxiliary 并统一 / 分隔', () => {
    const manifest = buildManifest({
      root,
      snapshot: {
        code_ref: 'master',
        code_refs: ['master', 'v1.0'],
        version_tag: 'v1.0',
        golden: { commit: 'abc1234' },
      },
      auxiliaryMaterials: ['docs/aux.md', '../escape.md'],
    });

    expect(manifest.gt6ce.root).toBe('code/current');
    expect(manifest.gt6ce.files).toEqual(['src/A.java']);
    expect(manifest.golden?.root).toBe('code/golden');
    expect(manifest.golden?.ref).toBe('abc1234');
    expect(manifest.history.map((item) => item.ref)).toEqual(['v1.0']);
    expect(manifest.history[0]?.files).toEqual(['src/A.java']);
    expect(manifest.extra).toEqual([]);
    expect(manifest.auxiliary.map((item) => item.root)).toEqual(['docs/aux.md']);
  });
});

describe('zip 解压防护', () => {
  let target: string;

  beforeAll(() => {
    target = mkdtempSync(join(tmpdir(), 'gt6ce-zip-'));
  });

  afterAll(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it('正常文件按相对路径展开', () => {
    const zip = makeZip([
      { name: 'logs/latest.log', data: Buffer.from('hello') },
      { name: 'crash/report.txt', data: Buffer.from('boom') },
    ]);
    const result = extractZip(zip, target, LIMITS);
    expect(result.files).toEqual(['logs/latest.log', 'crash/report.txt']);
    expect(result.totalBytes).toBe(9);
  });

  it('跳过路径穿越与绝对路径条目', () => {
    const zip = makeZip([
      { name: '../evil.txt', data: Buffer.from('x') },
      { name: '/abs.txt', data: Buffer.from('x') },
      { name: 'C:/win.txt', data: Buffer.from('x') },
      { name: 'ok.txt', data: Buffer.from('ok') },
    ]);
    const result = extractZip(zip, target, LIMITS);
    expect(result.files).toEqual(['ok.txt']);
  });

  it('累计解压量超过上限时拒绝', () => {
    const zip = makeZip([{ name: 'big.txt', data: Buffer.alloc(64) }]);
    expect(() =>
      extractZip(zip, target, { maxAttachmentBytes: 1024, maxTotalAttachmentBytes: 32 }),
    ).toThrowError(WorkspaceError);
  });

  it('非 zip 输入直接报错', () => {
    expect(() => extractZip(Buffer.from('not a zip'), target, LIMITS)).toThrowError(
      WorkspaceError,
    );
  });
});

describe('日志摘要', () => {
  it('按关键字筛选并脱敏路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'gt6ce-digest-'));
    try {
      mkdirSync(join(root, 'logs'), { recursive: true });
      writeFileSync(
        join(root, 'logs', 'latest.log'),
        ['[INFO] normal line', 'C:\\Users\\dev\\x.log ERROR boom 192.168.0.1', '[WARN] gregtech'].join(
          '\n',
        ),
      );
      const digest = buildLogDigest({ logsDir: join(root, 'logs'), baseDir: root });
      expect(digest).toContain('## logs/latest.log');
      expect(digest).toContain('<path> ERROR boom <ip>');
      expect(digest).not.toContain('normal line');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
