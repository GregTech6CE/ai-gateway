import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  boundedExec,
  keepCompleteLines,
  minimalExecEnv,
} from '../src/bounded-exec.ts';
import {
  READONLY_MCP_SERVER_NAME,
  READONLY_MCP_TOOLS,
  createReadonlyMcpHandler,
  startReadonlyMcpServer,
} from '../src/readonly-mcp.ts';
import {
  MAX_READ_FILE_BYTES,
  ToolError,
  gitDiffTool,
  gitLogTool,
  grepSearchTool,
  listFilesTool,
  readFileTool,
  resolveInside,
} from '../src/readonly-tools.ts';
import { createCodeTools } from '../src/tools.ts';

let workspace: string;
let outsideDir: string;
let commit1: string;
let commit2: string;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'tester@example.test',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.test',
    },
  }).trim();
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gt6ce-tools-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'gt6ce-outside-'));

  mkdirSync(join(workspace, 'code', 'current', 'src'), { recursive: true });
  mkdirSync(join(workspace, 'inputs', 'logs'), { recursive: true });
  mkdirSync(join(workspace, 'outputs'), { recursive: true });
  mkdirSync(join(workspace, 'secret-dir'), { recursive: true });

  writeFileSync(join(outsideDir, 'secret.txt'), 'outside-secret\n', 'utf8');
  writeFileSync(join(workspace, 'secret-dir', 'config.txt'), 'not-allowed-root\n', 'utf8');
  writeFileSync(join(workspace, 'code', 'current', '.env'), 'API_KEY=should-not-read\n', 'utf8');
  writeFileSync(
    join(workspace, 'code', 'current', '.env.local'),
    'LOCAL_SECRET=should-not-read\n',
    'utf8',
  );
  writeFileSync(
    join(workspace, 'code', 'current', 'prod.env'),
    'PROD_SECRET=should-not-read\n',
    'utf8',
  );
  writeFileSync(
    join(workspace, 'code', 'current', 'src', 'A.java'),
    [
      'package gregtech;',
      'public class A {',
      '  // line mentioning --pre=sh safely',
      '  int value = 1;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(workspace, 'code', 'current', 'src', 'binary.bin'),
    Buffer.from([0x41, 0x00, 0x42, 0x0a]),
  );
  writeFileSync(
    join(workspace, 'inputs', 'snapshot.json'),
    JSON.stringify({ issue: { number: 1, title: 'test' } }) + '\n',
    'utf8',
  );
  writeFileSync(join(workspace, 'outputs', 'log_digest.md'), '# digest\nERROR boom\n', 'utf8');

  // 初始化真实 git 仓库以覆盖 git_log 与 git_diff
  const repoDir = join(workspace, 'code', 'current');
  git(repoDir, ['init', '-b', 'master']);
  git(repoDir, ['add', 'src/A.java']);
  git(repoDir, ['commit', '-m', 'init: add class A']);
  commit1 = git(repoDir, ['rev-parse', 'HEAD']);

  writeFileSync(
    join(repoDir, 'src', 'A.java'),
    [
      'package gregtech;',
      'public class A {',
      '  // line mentioning --pre=sh safely',
      '  int value = 42;',
      '  String tag = "crucible";',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  git(repoDir, ['add', 'src/A.java']);
  git(repoDir, ['commit', '-m', 'fix: update value in A']);
  commit2 = git(repoDir, ['rev-parse', 'HEAD']);

  // 尝试创建区外与受限符号链接（Windows 若无文件 symlink 权限则改用目录 junction）
  try {
    symlinkSync(
      outsideDir,
      join(workspace, 'code', 'current', 'escape-dir-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    // 某些受限环境无法创建目录链接
  }
  try {
    symlinkSync(
      join(outsideDir, 'secret.txt'),
      join(workspace, 'code', 'current', 'escape-file-link.txt'),
      'file',
    );
  } catch {
    // Windows 非管理员默认不允许文件 symlink；目录 junction 仍覆盖真实逃逸
  }
  try {
    symlinkSync(
      join(workspace, 'code', 'current', '.env'),
      join(workspace, 'code', 'current', 'env-alias.txt'),
      'file',
    );
  } catch {
    // 同上
  }
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('boundedExec', () => {
  it('默认参数与最小环境变量仅保留 PATH 与 GIT_TERMINAL_PROMPT=0', async () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(64 * 1024);

    const env = minimalExecEnv({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      MODEL_KEY_MISTRAL: 'secret-a',
      GITHUB_TOKEN: 'secret-b',
      AWS_SECRET_ACCESS_KEY: 'secret-c',
    });
    expect(env).toEqual({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' });

    const result = await boundedExec(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      {
        env: {
          PATH: process.env.PATH,
          MODEL_KEY_MISTRAL: 'must-not-leak',
          GITHUB_TOKEN: 'must-not-leak',
        },
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.timed_out).toBe(false);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.GIT_TERMINAL_PROMPT).toBe('0');
    expect(childEnv.MODEL_KEY_MISTRAL).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(result.stdout).not.toContain('must-not-leak');
  });

  it('超过 64 KB 上限时立即终止并标记 truncated', async () => {
    const started = Date.now();
    const result = await boundedExec(
      process.execPath,
      [
        '-e',
        'const line = "x".repeat(1023) + "\\n"; for (let i = 0; i < 200; i++) process.stdout.write(line); setTimeout(() => {}, 10000);',
      ],
      { maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, timeoutMs: 10_000 },
    );
    expect(result.truncated).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('超时后保留完整行、裁去末尾残缺半行并返回 timed_out 与 truncated', async () => {
    expect(keepCompleteLines('line1\nline2\npartial')).toBe('line1\nline2\n');
    expect(keepCompleteLines('only-partial')).toBe('');

    const result = await boundedExec(
      process.execPath,
      [
        '-e',
        'process.stdout.write("first-line\\nsecond-line\\nincomplete-tail"); setTimeout(() => {}, 10000);',
      ],
      { timeoutMs: 300, killGraceMs: 200 },
    );
    expect(result.timed_out).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('first-line\nsecond-line\n');
    expect(result.stdout).not.toContain('incomplete-tail');
  });
});

describe('resolveInside 多根目录与安全边界', () => {
  it('允许 code/、inputs/、outputs/ 下的相对路径', () => {
    expect(resolveInside(workspace, 'code/current/src/A.java')).toBe(
      join(workspace, 'code', 'current', 'src', 'A.java'),
    );
    expect(resolveInside(workspace, 'inputs/snapshot.json')).toBe(
      join(workspace, 'inputs', 'snapshot.json'),
    );
    expect(resolveInside(workspace, 'outputs/log_digest.md')).toBe(
      join(workspace, 'outputs', 'log_digest.md'),
    );
  });

  it('拒绝空字节、绝对路径、.. 逃逸与允许根集合之外的路径', () => {
    expect(() => resolveInside(workspace, 'code/current/\0bad')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, '../etc/passwd')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'code/current/../../outside')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, '/etc/passwd')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'C:\\Windows\\win.ini')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'secret-dir/config.txt')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, '.')).toThrowError(ToolError);
  });

  it('拒绝 .git 与各类 .env 路径', () => {
    expect(() => resolveInside(workspace, 'code/current/.git')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'code/current/.git/config')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'code/current/.env')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'code/current/.env.local')).toThrowError(ToolError);
    expect(() => resolveInside(workspace, 'code/current/prod.env')).toThrowError(ToolError);
  });

  it('拒绝符号链接逃逸（含目录链接与文件链接）', () => {
    expect(() => resolveInside(workspace, 'code/current/escape-dir-link/secret.txt')).toThrowError(
      ToolError,
    );
    expect(() => resolveInside(workspace, 'code/current/escape-dir-link/nonexistent.txt')).toThrowError(
      ToolError,
    );
    try {
      readFileTool(workspace, { path: 'code/current/escape-file-link.txt' });
      throw new Error('不应放行区外文件符号链接');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
    }
    try {
      readFileTool(workspace, { path: 'code/current/env-alias.txt' });
      throw new Error('不应放行指向 .env 的符号链接');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
    }
  });
});

describe('5 只读工具功能与防注入', () => {
  it('list_files 正常列出文件且不暴露 .git/.env，拒绝非法 glob', async () => {
    const listed = await listFilesTool(workspace, { path: 'code/current', glob: '*.java' });
    expect(listed.entries).toEqual(['code/current/src/A.java']);
    expect(listed.truncated).toBe(false);

    const all = await listFilesTool(workspace, { path: 'code/current' });
    expect(all.entries.some((entry) => entry.includes('.git') || entry.includes('.env'))).toBe(
      false,
    );
    expect(all.entries.some((entry) => entry.includes('escape-dir-link'))).toBe(false);

    await expect(listFilesTool(workspace, { glob: '--pre=sh' })).rejects.toThrowError(ToolError);
    await expect(listFilesTool(workspace, { glob: '-c' })).rejects.toThrowError(ToolError);
    await expect(listFilesTool(workspace, { glob: '../*.java' })).rejects.toThrowError(ToolError);
    await expect(listFilesTool(workspace, { glob: '.env*' })).rejects.toThrowError(ToolError);
    await expect(listFilesTool(workspace, { glob: '*.java;rm' })).rejects.toThrowError(ToolError);
  });

  it('grep_search 以 -- 隔离 pattern（--pre=sh 当普通文本搜索）并支持 files_only 与 context_lines', async () => {
    // `--pre=sh` 作为模式传入必须被 `--` 隔离成普通文本，不能触发命令执行。
    const injected = await grepSearchTool(workspace, {
      pattern: '--pre=sh',
      path: 'code/current',
    });
    expect(injected.matches?.some((line) => line.includes('code/current/src/A.java:3:'))).toBe(
      true,
    );

    const filesOnly = await grepSearchTool(workspace, {
      pattern: 'crucible',
      path: 'code/current',
      files_only: true,
    });
    expect(filesOnly.files).toEqual(['code/current/src/A.java']);

    const withContext = await grepSearchTool(workspace, {
      pattern: 'crucible',
      path: 'code/current',
      context_lines: 1,
    });
    expect(withContext.matches?.some((line) => line.includes('int value = 42;'))).toBe(true);

    await expect(
      grepSearchTool(workspace, { pattern: 'class', glob: '--pre=sh' }),
    ).rejects.toThrowError(ToolError);
    await expect(
      grepSearchTool(workspace, { pattern: 'class', context_lines: 6 }),
    ).rejects.toThrowError(ToolError);
  });

  it('read_file 返回带行号文本与 total_lines，拒绝二进制与超大文件', () => {
    const read = readFileTool(workspace, { path: 'code/current/src/A.java', offset: 2, limit: 2 });
    expect(read.total_lines).toBe(6);
    expect(read.start_line).toBe(2);
    expect(read.end_line).toBe(3);
    expect(read.content).toBe('2: public class A {\n3:   // line mentioning --pre=sh safely');
    expect(read.truncated).toBe(true);

    expect(() => readFileTool(workspace, { path: 'code/current/src/binary.bin' })).toThrowError(
      ToolError,
    );
    expect(() =>
      readFileTool(workspace, { path: 'code/current/src/A.java' }, { maxFileBytes: 10 }),
    ).toThrowError(ToolError);
    expect(MAX_READ_FILE_BYTES).toBe(1_000_000);
  });

  it('git_log 与 git_diff 正常读取提交历史与差异，拒绝 - 开头或非法 ref/path', async () => {
    const log = await gitLogTool(workspace, {
      repo: 'code/current',
      path: 'src/A.java',
      ref: 'master',
      grep: 'update value',
      max_count: 5,
    });
    expect(log.output).toContain('fix: update value in A');
    expect(log.timed_out).toBe(false);

    const diff = await gitDiffTool(workspace, {
      repo: 'code/current',
      base: commit1,
      head: commit2,
      path: 'src/A.java',
    });
    expect(diff.output).toContain('-  int value = 1;');
    expect(diff.output).toContain('+  int value = 42;');

    const stat = await gitDiffTool(workspace, {
      repo: 'code/current',
      commit: commit2,
      stat_only: true,
    });
    expect(stat.output).toContain('src/A.java');
    expect(stat.output).not.toContain('+  int value = 42;');

    await expect(gitLogTool(workspace, { ref: '-c' })).rejects.toThrowError(ToolError);
    await expect(gitLogTool(workspace, { ref: '--exec=sh' })).rejects.toThrowError(ToolError);
    await expect(gitLogTool(workspace, { path: '../outside' })).rejects.toThrowError(ToolError);
    await expect(gitLogTool(workspace, { path: '-c' })).rejects.toThrowError(ToolError);

    await expect(gitDiffTool(workspace, { base: '--output=/tmp/pwn' })).rejects.toThrowError(
      ToolError,
    );
    await expect(gitDiffTool(workspace, { commit: '-c' })).rejects.toThrowError(ToolError);
    await expect(
      gitDiffTool(workspace, { base: commit1, head: '--ext-diff' }),
    ).rejects.toThrowError(ToolError);
    await expect(gitDiffTool(workspace, { commit: commit2, base: commit1 })).rejects.toThrowError(
      ToolError,
    );
  });

  it('createCodeTools 仅暴露 5 个只读工具，不暴露 run_bash', () => {
    const tools = createCodeTools({ root: workspace });
    expect(Object.keys(tools).sort()).toEqual([
      'git_diff',
      'git_log',
      'grep_search',
      'list_files',
      'read_file',
    ]);
    expect('run_bash' in tools).toBe(false);
  });
});

describe('stdio MCP 协议回环', () => {
  it('完成 initialize -> notifications/initialized -> tools/list -> tools/call 回环', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: Array<Record<string, unknown>> = [];

    let buffer = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== '') {
          responses.push(JSON.parse(line) as Record<string, unknown>);
        }
        idx = buffer.indexOf('\n');
      }
    });

    const serverDone = startReadonlyMcpServer({ roots: workspace, input, output });

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {} },
      })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'inputs/snapshot.json', offset: 1, limit: 10 } },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'code/current/.env' } },
      })}\n`,
    );
    input.end();

    await serverDone;

    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: READONLY_MCP_SERVER_NAME },
      },
    });

    const listResult = responses[1]?.result as { tools: typeof READONLY_MCP_TOOLS };
    expect(listResult.tools.map((t) => t.name)).toEqual([
      'list_files',
      'grep_search',
      'read_file',
      'git_log',
      'git_diff',
    ]);
    for (const toolDef of listResult.tools) {
      expect(toolDef.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const okCall = responses[2]?.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(okCall.isError).toBeUndefined();
    expect(JSON.parse(okCall.content[0]!.text)).toMatchObject({
      path: 'inputs/snapshot.json',
      total_lines: 1,
    });

    const errCall = responses[3]?.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(errCall.isError).toBe(true);
    expect(JSON.parse(errCall.content[0]!.text)).toMatchObject({
      error: expect.stringContaining('受限路径'),
    });

    // 额外校验未知工具与未知方法的 JSON-RPC 错误码
    const handler = createReadonlyMcpHandler(workspace);
    const unknownTool = await handler({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'run_bash', arguments: {} },
    });
    expect(unknownTool?.error?.code).toBe(-32602);

    const unknownMethod = await handler({ jsonrpc: '2.0', id: 10, method: 'resources/list' });
    expect(unknownMethod?.error?.code).toBe(-32601);
  });
});
