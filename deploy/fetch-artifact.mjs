#!/usr/bin/env node
/**
 * 从 snapshot Release 下载应用包，校验后解包到镜像的 `/app`。
 *
 * 只依赖 Node 内置能力与基础镜像自带的 `tar`：release 阶段不安装 curl。
 * 校验链与 CI 一致：清单里必须有精确的校验行，且 `.tgz` 的 SHA-256 必须完全匹配。
 *
 * 用法：
 *   node fetch-artifact.mjs --app gt6-qqbot --short <short> [--base <url>] --dest /app
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://github.com/GregTech6CE/ai-gateway/releases/download/snapshot';
const APP_PATTERN = /^gt6-[a-z0-9-]+$/;
const SHORT_PATTERN = /^[0-9a-f]{7,40}$/;

function fail(message) {
  process.stderr.write(`release 包准备失败：${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { base: DEFAULT_BASE, app: '', short: '', dest: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--')) {
      fail(`未知参数：${flag}`);
    }
    if (value === undefined || value.startsWith('--')) {
      fail(`${flag} 缺少参数`);
    }
    switch (flag) {
      case '--base':
        options.base = value;
        break;
      case '--app':
        options.app = value;
        break;
      case '--short':
        options.short = value;
        break;
      case '--dest':
        options.dest = value;
        break;
      default:
        fail(`未知参数：${flag}`);
    }
    index += 1;
  }

  if (!APP_PATTERN.test(options.app)) {
    fail(`--app 非法：${JSON.stringify(options.app)}`);
  }
  if (options.short === '') {
    fail('ARTIFACT_SHORT 为空：请传入 --build-arg ARTIFACT_SHORT=<short>');
  }
  if (!SHORT_PATTERN.test(options.short)) {
    fail(`ARTIFACT_SHORT 非法：${JSON.stringify(options.short)}（应为 7–40 位小写十六进制）`);
  }
  if (options.dest === '') {
    fail('--dest 不能为空');
  }
  if (!/^https?:\/\/[^/]+/.test(options.base)) {
    fail(`--base 必须是 http(s) 地址：${options.base}`);
  }
  options.base = options.base.replace(/\/+$/, '');
  return options;
}

async function download(base, name, target) {
  const url = `${base}/${name}`;
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    throw new Error(`下载失败：${url}（HTTP ${response.status}）`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, buffer);
  return buffer;
}

function expectedDigest(manifest, filename) {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^([0-9a-f]{64})  ${escaped}$`);
  for (const line of manifest.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) {
      return match[1];
    }
  }
  throw new Error(`SHASUMS256.txt 中没有 ${filename} 的校验行`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filename = `${options.app}-${options.short}.tgz`;
  const work = mkdtempSync(join(tmpdir(), 'gt6-artifact-'));
  try {
    const manifest = (
      await download(options.base, 'SHASUMS256.txt', join(work, 'SHASUMS256.txt'))
    ).toString('utf8');
    const expected = expectedDigest(manifest, filename);

    const archive = await download(options.base, filename, join(work, filename));
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== expected) {
      throw new Error(`sha256 不匹配：期望 ${expected}，实际 ${actual}`);
    }

    mkdirSync(options.dest, { recursive: true });
    execFileSync(
      'tar',
      [
        '-xzf',
        join(work, filename),
        '-C',
        options.dest,
        '--strip-components=1',
        'package/dist',
        'package/package.json',
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );

    const pkg = JSON.parse(readFileSync(join(options.dest, 'package.json'), 'utf8'));
    process.stdout.write(
      `已校验并解包 ${filename}（${actual.slice(0, 12)}…，${pkg.name ?? 'unknown'}）\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
