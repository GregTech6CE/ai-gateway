#!/usr/bin/env node
/**
 * 把 4 个应用打成自包含的 `.tgz`，并生成 `SHASUMS256.txt`。
 *
 * 产物结构固定为：
 *
 *   package/package.json
 *   package/dist/**            （该应用构建后的全部文件）
 *
 * `dist` 由 tsdown 打成自包含 bundle，只引用 `node:*`，因此解包后可直接
 * `node package/dist/main.js` 运行，不需要安装依赖。归档里不含 `src/`、
 * `node_modules/`、测试或文档。
 *
 * 用法：
 *   node scripts/pack-release.mjs [--out <dir>] [--hash <short>] [--repo <dir>]
 *
 * 默认输出到 `<repo>/release`，short hash 取 `git rev-parse --short=7 HEAD`。
 * 不引入任何第三方依赖：ustar 头与 gzip 都用 Node 内置模块生成。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** 打包目标：项目目录 → 发布资产名前缀。 */
export const APPS = Object.freeze([
  Object.freeze({ project: 'apps/ci', name: 'gt6-ci' }),
  Object.freeze({ project: 'apps/qqbot', name: 'gt6-qqbot' }),
  Object.freeze({ project: 'apps/agent-svc', name: 'gt6-agent-svc' }),
  Object.freeze({ project: 'apps/github-svc', name: 'gt6-github-svc' }),
]);

const HASH_PATTERN = /^[0-9a-f]{7,40}$/;

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

/** 超过 100 字节的路径按 ustar 约定拆到 prefix。 */
function splitName(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) {
    return { name: path, prefix: '' };
  }
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== '/') {
      continue;
    }
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`路径过长，无法写入 ustar 头：${path}`);
}

function createHeader(path, size, mode = 0o644) {
  const { name, prefix } = splitName(path);
  const header = Buffer.alloc(512, 0);

  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime：固定为 0，保证同样输入产出同样字节
  header.fill(0x20, 148, 156); // 校验和先填空格
  header.write('0', 156, 1, 'ascii'); // 普通文件
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  header.write(prefix, 345, 155, 'utf8');

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const text = checksum.toString(8).padStart(6, '0');
  header.write(text, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

/** 最小 ustar 写入器：只支持普通文件，足够打包 dist。 */
export function createTarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    chunks.push(createHeader(entry.name, data.length, entry.mode));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function walkFiles(root, relativeDir, collected) {
  const directory = join(root, relativeDir);
  const names = readdirSync(directory).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const relative = relativeDir === '' ? name : `${relativeDir}/${name}`;
    const absolute = join(root, relative);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walkFiles(root, relative, collected);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`dist 中出现非普通文件：${absolute}`);
    }
    collected.push({ path: relative, data: readFileSync(absolute) });
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 打包全部应用。
 *
 * @param {object} options
 * @param {string} options.repoRoot 仓库根目录
 * @param {string} options.outDir 输出目录（不存在时创建）
 * @param {string} options.shortHash 7–40 位小写十六进制提交号
 * @returns {{ outDir: string, shortHash: string, shasumsPath: string,
 *   artifacts: Array<{ filename: string, sha256: string, bytes: number, entries: number }> }}
 */
export function packAll(options) {
  const repoRoot = resolve(options.repoRoot);
  const outDir = resolve(options.outDir);
  const shortHash = String(options.shortHash ?? '').trim();
  if (!HASH_PATTERN.test(shortHash)) {
    throw new Error(`short hash 非法：${JSON.stringify(shortHash)}（应为 7–40 位小写十六进制）`);
  }

  mkdirSync(outDir, { recursive: true });
  const artifacts = [];

  for (const app of APPS) {
    const projectDir = join(repoRoot, app.project);
    const packagePath = join(projectDir, 'package.json');
    if (!existsSync(packagePath)) {
      throw new Error(`缺少 package.json：${packagePath}`);
    }
    const distDir = join(projectDir, 'dist');
    if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
      throw new Error(`缺少构建产物：${distDir}（先运行 rush rebuild）`);
    }

    const files = [];
    walkFiles(distDir, '', files);
    if (files.length === 0) {
      throw new Error(`dist 为空：${distDir}`);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));

    // package.json 放在最前，便于解包方先读元数据。
    const entries = [
      { name: 'package/package.json', data: readFileSync(packagePath) },
      ...files.map((file) => ({ name: `package/dist/${file.path}`, data: file.data })),
    ];
    const archive = createTarGz(entries);
    const filename = `${app.name}-${shortHash}.tgz`;
    writeFileSync(join(outDir, filename), archive);
    artifacts.push({
      filename,
      sha256: sha256(archive),
      bytes: archive.length,
      entries: entries.length,
    });
  }

  const lines = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.filename}`);
  const shasumsPath = join(outDir, 'SHASUMS256.txt');
  writeFileSync(shasumsPath, `${lines.join('\n')}\n`, 'utf8');

  return { outDir, shortHash, shasumsPath, artifacts };
}

function gitShortHash(repoRoot) {
  return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function parseArgs(argv, repoRoot) {
  const options = { repoRoot, outDir: join(repoRoot, 'release'), shortHash: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--out') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--out 缺少参数');
      }
      options.outDir = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (flag === '--hash') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--hash 缺少参数');
      }
      options.shortHash = value;
      index += 1;
      continue;
    }
    if (flag === '--repo') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--repo 缺少参数');
      }
      options.repoRoot = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      return { help: true };
    }
    throw new Error(`未知参数：${flag}`);
  }
  if (options.shortHash === '') {
    options.shortHash = gitShortHash(options.repoRoot);
  }
  return options;
}

function main(argv) {
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(argv, scriptRoot);
  if (options.help) {
    process.stdout.write(
      [
        '用法：node scripts/pack-release.mjs [--out <dir>] [--hash <short>] [--repo <dir>]',
        '',
        '  --out   输出目录；默认 <repo>/release，显式传入时相对当前工作目录',
        '  --hash  覆盖 git short hash，默认 git rev-parse --short=7 HEAD',
        '  --repo  仓库根目录，默认脚本所在仓库',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const result = packAll(options);
  for (const artifact of result.artifacts) {
    process.stdout.write(
      `${artifact.filename}  ${artifact.sha256}  ${artifact.bytes} bytes  ${artifact.entries} entries\n`,
    );
  }
  process.stdout.write(`清单：${result.shasumsPath}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`打包失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
