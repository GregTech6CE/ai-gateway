/**
 * `runAnalysis` 的失败策略测试。
 *
 * 重点是「模型输出不符合契约」这一类的处理：它必须是**快速失败**——
 * 不进入 60 秒退避重试，也不把入口写进 `cooldown`。冒烟测试（run 44439849850）里
 * 这个错误被误判成 network，导致 6 次重试、5 分钟空转、入口被封 2.5 小时。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatModel } from '@gt6ce/agent';

import { runAnalysis, type AnalysisEnv } from '../src/jobs/analysis.ts';
import type { StageDirs } from '../src/common.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ACP_FIXTURE = join(REPO_ROOT, 'packages/agent/test/fixtures/fake-acp-server.mjs');

const ANSWER = {
  issue_type: 'bug',
  issue_summary: ['合成器在加载时崩溃'],
  conclusion: '合成器在加载阶段崩溃，原因是配方索引为空。',
  root_cause: '配方索引在加载顺序变化后未重新构建。',
  confidence: 'high',
  confidence_reason: '崩溃日志与代码路径一致。',
  evidence: [{ summary: '空指针', file: 'src/a.ts', line_start: 10 }],
  user_advice: ['升级到最新版本'],
  fix_plan: ['在加载完成后重建索引'],
  labels: ['crash'],
  partial: false,
};

interface Harness {
  readonly baseUrl: string;
  readonly requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * 假 provider：第一问是相关性分类（无 tools），第二问是 agent 分析（带 tools）。
 * 分析这一步故意只回散文，复现「schema 未生效、模型自由作答」的真实形态。
 */
async function startProvider(
  analysisText = '我先看一下代码，稍后再给结论。',
): Promise<Harness> {
  const requests: Array<Record<string, unknown>> = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      requests.push(body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const text = hasTools
        ? analysisText
        : JSON.stringify({ relevance: 'in_scope', confidence: 0.95, reason: '缺陷报告' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      );
    });
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const open: Harness[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly dirs: StageDirs;
  readonly env: AnalysisEnv;
}

/** 复制仓库的真实 config/prompts，只用 model.json 把入口固定成给定集合。 */
function makeFixture(
  baseUrl: string,
  extraEntries: Array<Record<string, unknown>> = [],
  extraKeys: Record<string, string> = {},
  includeDefault = true,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gt6-analysis-'));
  tempDirs.push(root);
  cpSync(join(REPO_ROOT, 'config'), join(root, 'config'), { recursive: true });
  cpSync(join(REPO_ROOT, 'prompts'), join(root, 'prompts'), { recursive: true });
  for (const name of ['inputs', 'outputs', 'templates', 'code']) {
    mkdirSync(join(root, name), { recursive: true });
  }

  writeFileSync(
    join(root, 'inputs', 'snapshot.json'),
    JSON.stringify({
      repo: 'gregtech6ce/gregtech6',
      issue: {
        number: 406,
        title: '聚变反应堆主方块 tooltip 物质组成不符',
        body: 'tooltip 里的材料总量与实际合成材料不一致。',
        labels: ['bug', 'needs triage'],
      },
    }),
  );
  writeFileSync(
    join(root, 'inputs', 'model.json'),
    JSON.stringify({
      analysis_entries: [
        ...extraEntries,
        ...(includeDefault
          ? [
              {
                id: 'test-entry',
                provider: 'test',
                base_url: baseUrl,
                api_key_env: 'MODEL_KEY_TEST',
                model: 'test-model',
                role: 'analysis',
                weight: 1,
                structured_outputs: true,
              },
            ]
          : []),
      ],
    }),
  );

  return {
    dirs: {
      root,
      inputs: join(root, 'inputs'),
      outputs: join(root, 'outputs'),
      config: join(root, 'config'),
      prompts: join(root, 'prompts'),
      templates: join(root, 'templates'),
      code: join(root, 'code'),
    },
    env: {
      REPO: 'gregtech6ce/gregtech6',
      ISSUE: '406',
      BOT_ENABLED: 'true',
      MODEL_KEYS: { MODEL_KEY_TEST: 'test-key', ...extraKeys },
    },
  };
}

function readHealth(dirs: StageDirs): {
  endpoints?: Record<string, { status?: string; failures?: number }>;
} {
  return JSON.parse(readFileSync(join(dirs.outputs, 'model_health.json'), 'utf8')) as {
    endpoints?: Record<string, { status?: string; failures?: number }>;
  };
}

describe('runAnalysis 遇到 AgentError', () => {
  it('快速失败：不重试、不退避、不把入口置入 cooldown', async () => {
    const harness = await startProvider();
    open.push(harness);
    const { dirs, env } = makeFixture(harness.baseUrl);
    const sleep = vi.fn(async (_ms: number) => {});

    const outcome = await runAnalysis({
      env,
      dirs,
      sleep,
      createModel: () =>
        createChatModel({
          baseUrl: harness.baseUrl,
          apiKey: 'test-key',
          model: 'test-model',
          providerName: 'test',
        }),
    });

    // 1. 失败原因是「不符合契约」，不是 network。
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('模型输出无法解析为结构化结论');
    expect(outcome.reason).not.toContain('network');

    // 2. 只尝试了一次：没有 60s 退避，也没有换入口重来。
    expect(outcome.result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();

    // 3. 请求数 = 相关性分类 + 探索 + 1 次格式化，没有第 4~7 次重试。
    expect(harness.requests).toHaveLength(3);
    expect(harness.requests[0]?.tools).toBeUndefined();
    expect(Array.isArray(harness.requests[1]?.tools)).toBe(true);
    // 关键：探索请求不能带 response_format，否则网关会丢弃 tool_calls、循环当场结束。
    expect(harness.requests[1]?.response_format).toBeUndefined();
    // 格式化请求反过来：不带 tools，才允许带 response_format。
    expect(harness.requests[2]?.tools).toBeUndefined();
    expect(harness.requests[2]?.response_format).toBeDefined();

    // 4. 入口没有被判故障：没有 cooldown，也没有失败计数。
    const health = readHealth(dirs);
    const entry = health.endpoints?.['test-entry'];
    expect(entry?.status).not.toBe('cooldown');
    expect(entry?.failures ?? 0).toBe(0);

    // 5. result.json 也如实记录：失败不代表「没花代价」，steps/tokens 不能写 0。
    const result = JSON.parse(readFileSync(join(dirs.outputs, 'result.json'), 'utf8')) as {
      status: string;
      reason: string;
      attempts: number;
      steps: number;
      tokens: number;
    };
    expect(result).toMatchObject({ status: 'failed', attempts: 1, steps: 1 });
    expect(result.tokens).toBeGreaterThan(0);
  });
});

function acpEntry(scenario: string, recordPath: string): Record<string, unknown> {
  return {
    id: 'vibe-entry',
    provider: 'mistral',
    driver: 'acp',
    api_key_env: 'MODEL_KEY_MISTRAL',
    model: 'mistral-large-4-0',
    role: 'analysis',
    weight: 2,
    acp: {
      command: process.execPath,
      args: [ACP_FIXTURE, scenario, recordPath],
      api_key_target_env: 'FAKE_API_KEY',
      preset: 'generic',
    },
  };
}

describe('runAnalysis 在 ACP 入口故障时切换', () => {
  it(
    '进程异常退出后切换到下一个 OpenAI 兼容入口',
    { timeout: 30_000 },
    async () => {
      const harness = await startProvider(JSON.stringify(ANSWER));
      open.push(harness);
      const recordDir = mkdtempSync(join(tmpdir(), 'gt6-acp-failover-'));
      tempDirs.push(recordDir);
      const { dirs, env } = makeFixture(
        harness.baseUrl,
        [acpEntry('exit-auth', join(recordDir, 'record.json'))],
        { MODEL_KEY_MISTRAL: 'acp-key' },
      );

      const outcome = await runAnalysis({
        env,
        dirs,
        createModel: () =>
          createChatModel({
            baseUrl: harness.baseUrl,
            apiKey: 'test-key',
            model: 'test-model',
            providerName: 'test',
          }),
      });

      expect(outcome.status).toBe('complete');
      expect(outcome.result.entry_id).toBe('test-entry');
      expect(outcome.result.attempts).toBe(2);

      const health = readHealth(dirs);
      expect(health.endpoints?.['vibe-entry']?.status).toBe('cooldown');
      expect(health.endpoints?.['test-entry']?.status).toBe('ok');

      // 分类优先走 OpenAI 兼容入口，不消耗 ACP 会话。
      const relevance = JSON.parse(
        readFileSync(join(dirs.outputs, 'relevance.json'), 'utf8'),
      ) as { entry_id?: string };
      expect(relevance.entry_id).toBe('test-entry');
    },
  );

  it(
    'ACP 入口 5xx 重试 1 次后切换到 OpenAI 兼容入口',
    { timeout: 30_000 },
    async () => {
      const harness = await startProvider(JSON.stringify(ANSWER));
      open.push(harness);
      const recordDir = mkdtempSync(join(tmpdir(), 'gt6-acp-retry-'));
      tempDirs.push(recordDir);
      const { dirs, env } = makeFixture(
        harness.baseUrl,
        [acpEntry('analysis-5xx', join(recordDir, 'record.json'))],
        { MODEL_KEY_MISTRAL: 'acp-key' },
      );
      const sleep = vi.fn(async (_ms: number) => {});

      const outcome = await runAnalysis({
        env,
        dirs,
        sleep,
        createModel: () =>
          createChatModel({
            baseUrl: harness.baseUrl,
            apiKey: 'test-key',
            model: 'test-model',
            providerName: 'test',
          }),
      });

      expect(outcome.status).toBe('complete');
      expect(outcome.result.entry_id).toBe('test-entry');
      // ACP 两次尝试（首次 + 1 次重试），再切换成功一次。
      expect(outcome.result.attempts).toBe(3);
      expect(sleep).toHaveBeenCalledTimes(1);

      const health = readHealth(dirs);
      expect(health.endpoints?.['vibe-entry']?.failures).toBe(2);
      expect(health.endpoints?.['test-entry']?.status).toBe('ok');
    },
  );

  it(
    '全部入口失败时记录脱敏错误详情与非零 steps',
    { timeout: 30_000 },
    async () => {
      const recordDir = mkdtempSync(join(tmpdir(), 'gt6-acp-all-fail-'));
      tempDirs.push(recordDir);
      const { dirs, env } = makeFixture(
        'http://127.0.0.1:9/v1',
        [acpEntry('analysis-5xx', join(recordDir, 'record.json'))],
        { MODEL_KEY_MISTRAL: 'acp-key' },
        false,
      );
      const sleep = vi.fn(async (_ms: number) => {});

      const outcome = await runAnalysis({ env, dirs, sleep });

      expect(outcome.status).toBe('failed');
      expect(outcome.result.entry_id).toBe('vibe-entry');
      expect(outcome.result.attempts).toBe(2);
      expect(outcome.result.steps).toBe(2);

      const detail = String(outcome.result.error_detail ?? '');
      expect(detail).toContain('503');
      expect(detail).not.toContain('acp-key');
      expect(detail.length).toBeLessThanOrEqual(500);

      const persisted = JSON.parse(
        readFileSync(join(dirs.outputs, 'result.json'), 'utf8'),
      ) as {
        status?: string;
        entry_id?: string;
        attempts?: number;
        steps?: number;
        error_detail?: string;
      };
      expect(persisted).toMatchObject({
        status: 'failed',
        entry_id: 'vibe-entry',
        attempts: 2,
        steps: 2,
      });
      expect(String(persisted.error_detail ?? '')).toContain('503');
      expect(String(persisted.error_detail ?? '')).not.toContain('acp-key');
    },
  );
});
