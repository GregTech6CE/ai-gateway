/**
 * ACP 驱动的协议级测试：假 agent 用裸 ndjson 实现，覆盖握手、审批、流式组装、
 * 软超时/绕圈取消与进程异常映射。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelsConfigSchema } from '@gt6ce/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acpCommandAvailable,
  classifyRelevanceWithAcp,
  isGt6ReadOnlyMcpTool,
  runAcpAnalysis,
} from '../src/acp-client.ts';
import { bindings, loadPool, type ModelEntry } from '../src/model-pool.ts';

const cleanupFailure = vi.hoisted(() => ({ enabled: false, calls: 0 }));

const spawnFailure = vi.hoisted(() => ({ code: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    if (spawnFailure.code) {
      throw Object.assign(new Error(`spawn ${spawnFailure.code}`), { code: spawnFailure.code });
    }
    return actual.spawn(...args);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

vi.mock('../src/vibe-env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vibe-env.ts')>();
  return {
    ...actual,
    prepareAcpChildEnv: (...args: Parameters<typeof actual.prepareAcpChildEnv>) => {
      const prepared = actual.prepareAcpChildEnv(...args);
      return {
        ...prepared,
        cleanup: () => {
          cleanupFailure.calls += 1;
          prepared.cleanup();
          if (cleanupFailure.enabled) {
            throw Object.assign(new Error('EACCES: permission denied, unlink plugin.json'), {
              code: 'EACCES',
            });
          }
        },
      };
    },
  };
});

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));

const PROMPT = {
  system: '你是 issue 分析器。',
  user: '分析这个 issue。',
  profile: 'test',
};

const RELEVANCE_PROMPT = {
  system: '判断 issue 是否相关。',
  user: '标题：崩溃\n正文：启动即崩溃。',
};

interface Recorded {
  readonly prompts: number;
  readonly cancels: number;
  readonly decisions: string[];
  readonly additionalDirectories: string[];
  readonly mcpServers: Array<{
    readonly name: string;
    readonly command: string;
    readonly args: string[];
  }>;
}

const tempDirs: string[] = [];

afterEach(() => {
  cleanupFailure.enabled = false;
  cleanupFailure.calls = 0;
  spawnFailure.code = '';
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gt6-acp-test-'));
  tempDirs.push(dir);
  return dir;
}

function entryFor(scenario: string, recordPath: string): ModelEntry {
  const config = ModelsConfigSchema.parse({
    pools: {
      shared: {
        endpoints: [
          {
            id: 'vibe',
            provider: 'mistral',
            driver: 'acp',
            api_key_env: 'MODEL_KEY_MISTRAL',
            model: 'mistral-large-4-0',
            acp: {
              command: process.execPath,
              args: [FIXTURE, scenario, recordPath],
              api_key_target_env: 'FAKE_API_KEY',
              preset: 'generic',
            },
          },
        ],
        roles: { analysis: [{ endpoint: 'vibe', weight: 1 }] },
      },
    },
  });
  return bindings(loadPool(config, 'shared'), 'analysis')[0]!;
}

function record(path: string): Recorded {
  return JSON.parse(readFileSync(path, 'utf8')) as Recorded;
}

describe('runAcpAnalysis', () => {
  it(
    '完成握手、流式组装，并只放行只读工具',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('read-flow', recordPath);
      const outcome = await runAcpAnalysis({
        entry,
        apiKey: 'test-key',
        prompt: PROMPT,
        cwd: dir,
        additionalDirectories: [dir],
        timeoutMs: 10_000,
      });

      expect(outcome.answer).toMatchObject({ issue_type: 'bug', confidence: 'high' });
      expect(outcome.profile).toBe('test');
      expect(outcome.finishReason).toBe('end_turn');
      expect(outcome.steps).toBe(7);
      expect(record(recordPath)).toMatchObject({
        prompts: 1,
        decisions: [
          'allow-option',
          'deny-option',
          'deny-option',
          'deny-option',
          'deny-option',
          'deny-option',
          'deny-option',
        ],
        additionalDirectories: [dir],
      });
    },
  );

  it(
    '清理阶段抛错时仍返回分析结果',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('read-flow', recordPath);
      cleanupFailure.enabled = true;
      cleanupFailure.calls = 0;
      try {
        const outcome = await runAcpAnalysis({
          entry,
          apiKey: 'test-key',
          prompt: PROMPT,
          cwd: dir,
          timeoutMs: 10_000,
        });
        expect(outcome.answer).toMatchObject({ issue_type: 'bug', confidence: 'high' });
        expect(outcome.finishReason).toBe('end_turn');
        expect(cleanupFailure.calls).toBeGreaterThan(0);
      } finally {
        cleanupFailure.enabled = false;
      }
    },
  );

  it(
    '拉起 ACP 进程遇 EACCES/EPERM 归类为 config',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const command = join(dir, 'vibe-acp');
      writeFileSync(command, '#!/bin/sh\nexit 0\n', 'utf8');
      if (process.platform !== 'win32') {
        chmodSync(command, 0o755);
      }
      const base = entryFor('read-flow', join(dir, 'record.json'));
      const entry: ModelEntry = { ...base, acp: { ...base.acp!, command } };
      for (const code of ['EACCES', 'EPERM']) {
        cleanupFailure.calls = 0;
        spawnFailure.code = code;
        try {
          // spawn 抛出的错误与异步 'error' 事件共用 mapAcpFailure 的归类逻辑。
          await expect(
            runAcpAnalysis({
              entry,
              apiKey: 'test-key',
              prompt: PROMPT,
              cwd: dir,
            }),
          ).rejects.toMatchObject({
            name: 'ModelError',
            kind: 'config',
            status: 0,
            detail: expect.stringContaining(`spawn ${code}`),
          });
          expect(cleanupFailure.calls).toBeGreaterThan(0);
        } finally {
          spawnFailure.code = '';
        }
      }
    },
  );

  it(
    '进程以鉴权错误退出时抛 ModelError(auth)',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('exit-auth', recordPath);
      await expect(
        runAcpAnalysis({
          entry,
          apiKey: 'test-key',
          prompt: PROMPT,
          cwd: dir,
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ name: 'ModelError', kind: 'auth', status: 401 });
    },
  );

  it(
    '5xx 归类为 upstream、保留详情与真实步数',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('analysis-5xx', recordPath);
      let caught: unknown;
      try {
        await runAcpAnalysis({
          entry,
          apiKey: 'test-key',
          prompt: PROMPT,
          cwd: dir,
          timeoutMs: 10_000,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        name: 'ModelError',
        kind: 'upstream',
        status: 503,
        steps: 2,
      });
      const detail = (caught as { detail?: string }).detail ?? '';
      expect(detail).toContain('503');
      expect(detail).not.toContain('test-key');
    },
  );

  it(
    '绕圈达到阈值时发送 session/cancel，并用无工具兜底收尾',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('loop', recordPath);
      const outcome = await runAcpAnalysis({
        entry,
        apiKey: 'test-key',
        prompt: PROMPT,
        cwd: dir,
        loopRepeatThreshold: 3,
        timeoutMs: 8_000,
      });

      expect(outcome.answer.issue_type).toBe('bug');
      expect(outcome.steps).toBe(3);
      expect(record(recordPath)).toMatchObject({ prompts: 2, cancels: 1 });
    },
  );

  it(
    '握手完成后清掉初始化超时定时器',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('slow-init', recordPath);
      const outcome = await runAcpAnalysis({
        entry,
        apiKey: 'test-key',
        prompt: PROMPT,
        cwd: dir,
        initTimeoutMs: 1500,
        timeoutMs: 5_000,
      });

      expect(outcome.answer.issue_type).toBe('bug');
      expect(outcome.finishReason).toBe('end_turn');
    },
  );

  it(
    '透传 mcpServers 并放行 gt6-readonly 的 5 个只读工具，拒绝写与执行工具',
    { timeout: 15_000 },
    async () => {
      expect(isGt6ReadOnlyMcpTool('mcp_gt6_readonly.git_log')).toBe(true);
      expect(isGt6ReadOnlyMcpTool('gt6-readonly:git_diff')).toBe(true);
      expect(isGt6ReadOnlyMcpTool('gt6_readonly_grep_search')).toBe(true);
      expect(isGt6ReadOnlyMcpTool('mcp__gt6-readonly__list_files')).toBe(true);
      expect(isGt6ReadOnlyMcpTool('mcp_gt6_readonly.write_file')).toBe(false);
      expect(isGt6ReadOnlyMcpTool('other_server.git_log')).toBe(false);

      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('mcp-readonly', recordPath);
      const outcome = await runAcpAnalysis({
        entry,
        apiKey: 'test-key',
        prompt: PROMPT,
        cwd: dir,
        mcpServers: [
          {
            name: 'gt6-readonly',
            command: process.execPath,
            args: ['readonly-mcp.js', '--code', dir],
            env: [],
          },
        ],
        timeoutMs: 10_000,
      });

      expect(outcome.answer).toMatchObject({ issue_type: 'bug', confidence: 'high' });
      expect(record(recordPath)).toMatchObject({
        prompts: 1,
        mcpServers: [
          {
            name: 'gt6-readonly',
            command: process.execPath,
            args: ['readonly-mcp.js', '--code', dir],
          },
        ],
        decisions: [
          'allow-option',
          'allow-option',
          'allow-option',
          'allow-option',
          'allow-option',
          'deny-option',
          'deny-option',
        ],
      });
    },
  );

  it(
    '正文不可解析时发起一次无工具格式化，兜底阶段拒绝工具',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('bad-text', recordPath);
      const outcome = await runAcpAnalysis({
        entry,
        apiKey: 'test-key',
        prompt: PROMPT,
        cwd: dir,
        timeoutMs: 10_000,
      });

      expect(outcome.answer.issue_type).toBe('bug');
      expect(outcome.steps).toBe(1);
      expect(record(recordPath)).toMatchObject({
        prompts: 2,
        decisions: ['deny-option'],
      });
    },
  );
});

describe('classifyRelevanceWithAcp', () => {
  it(
    '软超时触发 session/cancel，截断的文本不可解析时返回 undefined',
    { timeout: 15_000 },
    async () => {
      const dir = workDir();
      const recordPath = join(dir, 'record.json');
      const entry = entryFor('soft-timeout', recordPath);
      const verdict = await classifyRelevanceWithAcp({
        entry,
        apiKey: 'test-key',
        prompt: RELEVANCE_PROMPT,
        cwd: dir,
        timeoutMs: 300,
      });

      expect(verdict).toBeUndefined();
      expect(record(recordPath).cancels).toBe(1);
    },
  );
});

describe('命令可用性', () => {
  it('缺失的可执行文件不做网络探活，直接判定为 config 错误', async () => {
    const dir = workDir();
    const recordPath = join(dir, 'record.json');
    const entry = entryFor('read-flow', recordPath);
    const missing: ModelEntry = {
      ...entry,
      acp: { ...entry.acp!, command: 'gt6ce-definitely-missing-acp-command' },
    };
    expect(acpCommandAvailable(missing)).toBe(false);
    await expect(
      runAcpAnalysis({
        entry: missing,
        apiKey: 'test-key',
        prompt: PROMPT,
        cwd: dir,
      }),
    ).rejects.toMatchObject({ name: 'ModelError', kind: 'config' });
  });
});
