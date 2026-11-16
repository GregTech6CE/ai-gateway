import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ToolError,
  resolveInside,
  runBash,
  sanitizedEnv,
} from '../src/tools.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gt6ce-tools-'));
  mkdirSync(join(root, 'code', 'current'), { recursive: true });
  writeFileSync(join(root, 'code', 'current', 'A.java'), 'class A {}\n', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('允许工作区内的相对路径', () => {
    expect(resolveInside(root, 'code/current/A.java')).toBe(
      join(root, 'code', 'current', 'A.java'),
    );
  });

  it('拒绝 .. 逃逸与绝对路径', () => {
    expect(() => resolveInside(root, '../etc/passwd')).toThrowError(ToolError);
    expect(() => resolveInside(root, '/etc/passwd')).toThrowError(ToolError);
    expect(() => resolveInside(root, 'C:\\Windows\\win.ini')).toThrowError(ToolError);
  });
});

describe('sanitizedEnv', () => {
  it('只保留白名单变量，密钥全部剔除', () => {
    const env = sanitizedEnv({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HOME: '/home/x',
      HTTP_PROXY: 'http://proxy:8080',
      MODEL_KEY_ALPHA: 'secret-a',
      MODEL_KEY_BETA: 'secret-b',
      GITHUB_TOKEN: 'gh',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HTTP_PROXY', 'LANG', 'PATH']);
    expect(JSON.stringify(env)).not.toContain('secret-a');
  });
});

describe('runBash', () => {
  const baseOptions = {
    root,
    timeoutMs: 10_000,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      MODEL_KEY_ALPHA: 'secret-value-alpha',
      GITHUB_TOKEN: 'secret-token',
    } as NodeJS.ProcessEnv,
  };

  it('子进程环境零密钥', async () => {
    const result = await runBash('node -e "console.log(JSON.stringify(process.env))"', baseOptions);
    expect(result.exit_code).toBe(0);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.MODEL_KEY_ALPHA).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(result.stdout).not.toContain('secret-value-alpha');
  });

  it('拒绝白名单外的可执行文件', async () => {
    await expect(runBash('bash -lc "echo hi"', baseOptions)).rejects.toThrowError(ToolError);
    await expect(runBash('rm -rf /', baseOptions)).rejects.toThrowError(ToolError);
  });

  it('拒绝 shell 元字符', async () => {
    await expect(runBash('git log | head', baseOptions)).rejects.toThrowError(ToolError);
    await expect(runBash('curl http://x > out', baseOptions)).rejects.toThrowError(ToolError);
    await expect(runBash('node -e $(date)', baseOptions)).rejects.toThrowError(ToolError);
  });

  it('超时杀掉子进程并标记', async () => {
    const result = await runBash('node -e "setTimeout(()=>{},5000)"', {
      ...baseOptions,
      timeoutMs: 200,
    });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
  });

  it('输出超限被截断', async () => {
    const result = await runBash('node -e "process.stdout.write(String(Math.random()).repeat(500))"', {
      ...baseOptions,
      maxOutputBytes: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });
});
