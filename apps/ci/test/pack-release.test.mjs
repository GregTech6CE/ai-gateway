import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APPS, packAll } from '../../../scripts/pack-release.mjs';

const HASH = 'abc1234';

/** 打包逻辑在仓库根目录，但 `rush test` 只跑注册项目：测试放在 ci 项目里。 */
const tempDirs = [];
let repoRoot;
let outDir;

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** 造一个最小仓库：每个应用只有 dist 与 package.json 应该进包。 */
function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pack-release-'));
  tempDirs.push(root);
  for (const app of APPS) {
    const dir = join(root, app.project);
    writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: app.name, type: 'module', main: './dist/main.js' }, null, 2)}\n`,
    );
    writeFile(join(dir, 'dist', 'main.js'), `console.log(${JSON.stringify(app.name)});\n`);
    writeFile(join(dir, 'dist', 'chunks', 'worker.js'), 'export const worker = 1;\n');
    // 以下都不应进入归档。
    writeFile(join(dir, 'src', 'main.ts'), 'export const source = true;\n');
    writeFile(join(dir, 'test', 'main.test.ts'), 'export const test = true;\n');
    writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = {};\n');
    writeFile(join(dir, 'README.md'), '# 不应打包\n');
  }
  return root;
}

/** 独立实现的最小 ustar 读取器：验证写出的归档确实可被解析。 */
function listEntries(tgzPath) {
  const tar = gunzipSync(readFileSync(tgzPath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    entries.push({
      path: prefix === '' ? name : `${prefix}/${name}`,
      size,
      type: String.fromCharCode(header[156]),
      data,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

beforeEach(() => {
  repoRoot = createRepo();
  outDir = mkdtempSync(join(tmpdir(), 'pack-out-'));
  tempDirs.push(outDir);
});

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('pack-release', () => {
  it('为 4 个应用生成只含 package.json 与 dist 的自包含归档', () => {
    const result = packAll({ repoRoot, outDir, shortHash: HASH });

    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual([
      `gt6-ci-${HASH}.tgz`,
      `gt6-qqbot-${HASH}.tgz`,
      `gt6-agent-svc-${HASH}.tgz`,
      `gt6-github-svc-${HASH}.tgz`,
    ]);

    const entries = listEntries(join(outDir, `gt6-ci-${HASH}.tgz`));
    expect(entries.map((entry) => entry.path)).toEqual([
      'package/package.json',
      'package/dist/chunks/worker.js',
      'package/dist/main.js',
    ]);
    expect(entries.every((entry) => entry.type === '0')).toBe(true);
    expect(entries.some((entry) => entry.path.includes('/src/'))).toBe(false);
    expect(entries.some((entry) => entry.path.includes('/node_modules/'))).toBe(false);
    expect(entries.some((entry) => entry.path.endsWith('README.md'))).toBe(false);

    const pkg = JSON.parse(entries[0].data.toString('utf8'));
    expect(pkg).toMatchObject({ name: 'gt6-ci', main: './dist/main.js' });

    // dist 内容原样保留：嵌套文件与源码内容都能读回。
    const worker = entries.find((entry) => entry.path.endsWith('chunks/worker.js'));
    expect(worker?.data.toString('utf8')).toBe('export const worker = 1;\n');
  });

  it('SHASUMS256.txt 覆盖 4 个资产且哈希与文件一致', () => {
    packAll({ repoRoot, outDir, shortHash: HASH });

    const lines = readFileSync(join(outDir, 'SHASUMS256.txt'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);

    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (gt6-(?:ci|qqbot|agent-svc|github-svc)-[0-9a-f]{7}\.tgz)$/.exec(
        line,
      );
      expect(match, `清单行格式不正确：${line}`).not.toBeNull();
      const actual = createHash('sha256')
        .update(readFileSync(join(outDir, match[2])))
        .digest('hex');
      expect(actual).toBe(match[1]);
    }
  });

  it('同样输入产出同样字节（可复现构建）', () => {
    const first = packAll({ repoRoot, outDir: join(outDir, 'a'), shortHash: HASH });
    const second = packAll({ repoRoot, outDir: join(outDir, 'b'), shortHash: HASH });

    expect(first.artifacts.map((artifact) => artifact.sha256)).toEqual(
      second.artifacts.map((artifact) => artifact.sha256),
    );
  });

  it('缺少 dist 时拒绝打包', () => {
    rmSync(join(repoRoot, 'apps/qqbot/dist'), { recursive: true, force: true });

    expect(() => packAll({ repoRoot, outDir, shortHash: HASH })).toThrowError(/缺少构建产物/);
  });

  it('非法 short hash 直接拒绝', () => {
    expect(() => packAll({ repoRoot, outDir, shortHash: 'HEAD' })).toThrowError(/short hash 非法/);
    expect(() => packAll({ repoRoot, outDir, shortHash: 'ABC1234' })).toThrowError(
      /short hash 非法/,
    );
  });
});
