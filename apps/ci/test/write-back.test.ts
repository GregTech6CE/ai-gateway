import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StageDirs } from '../src/common.ts';
import { runWriteBack, type WriteBackEnv } from '../src/jobs/write-back.ts';

const REPO_CONFIG = fileURLToPath(new URL('../../../config', import.meta.url));

let root: string;
let dirs: StageDirs;

function makeDirs(): StageDirs {
  root = mkdtempSync(join(tmpdir(), 'gt6ce-writeback-'));
  const inputs = join(root, 'inputs');
  const outputs = join(root, 'outputs');
  mkdirSync(inputs, { recursive: true });
  mkdirSync(outputs, { recursive: true });
  return {
    root,
    inputs,
    outputs,
    config: REPO_CONFIG,
    prompts: join(root, 'prompts'),
    templates: join(root, 'templates'),
    code: join(root, 'code'),
  };
}

function env(overrides: Partial<WriteBackEnv> = {}): WriteBackEnv {
  return {
    REPO: 'gregtech6ce/gregtech6',
    ISSUE: '5',
    COMMENT_ID: '77',
    GH_RW_TOKEN: 'rw',
    GH_RO_TOKEN: 'ro',
    BOT_ENABLED: 'true',
    DRY_RUN: 'false',
    RUN_URL: 'https://example.test/run/1',
    RUN_ID: '1',
    ...overrides,
  };
}

interface MockIssue {
  readonly state?: string;
  readonly labels?: ReadonlyArray<{ name: string }>;
}

function mockFetch(options: { issue?: MockIssue } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const json = (status: number, value: unknown): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url: input,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const path = url.pathname;
    if (method === 'GET' && path === '/repos/gregtech6ce/gregtech6/issues/5') {
      return json(200, {
        number: 5,
        state: options.issue?.state ?? 'open',
        labels: options.issue?.labels ?? [],
      });
    }
    if (method === 'PATCH' && path === '/repos/gregtech6ce/gregtech6/issues/comments/77') {
      return json(200, { id: 77 });
    }
    if (method === 'POST' && path === '/repos/gregtech6ce/gregtech6/issues/5/comments') {
      return json(201, { id: 999 });
    }
    if (method === 'GET' && path === '/repos/gregtech6ce/gregtech6/labels') {
      return json(200, []);
    }
    return new Response(null, { status: 204 });
  };
  return { fetchImpl, calls };
}

const COMMENT = ['## 结论', '', '合成器在加载阶段崩溃。', '', '<!-- bot:v1:done type=success run=1 -->', ''].join(
  '\n',
);

function writeOutputs(body: string, result?: unknown): void {
  writeFileSync(join(dirs.outputs, 'comment.md'), body, 'utf8');
  if (result !== undefined) {
    writeFileSync(join(dirs.outputs, 'result.json'), JSON.stringify(result), 'utf8');
  }
}

beforeEach(() => {
  dirs = makeDirs();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runWriteBack', () => {
  it('有占位评论时原地 PATCH', async () => {
    writeOutputs(COMMENT);
    const { fetchImpl, calls } = mockFetch();

    const outcome = await runWriteBack({ env: env(), dirs, fetchImpl });

    expect(outcome.action).toBe('published');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]?.body).toEqual({ body: COMMENT });
  });

  it('占位评论 404 时回退新建', async () => {
    writeOutputs(COMMENT);
    const calls: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'GET') {
        return new Response(JSON.stringify({ number: 5, state: 'open', labels: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: 999 }), { status: 201 });
    };

    const outcome = await runWriteBack({ env: env(), dirs, fetchImpl });

    expect(outcome.action).toBe('published');
    expect(calls).toEqual(['GET', 'PATCH', 'POST']);
  });

  it('正文命中敏感信息时阻断，不发布原评论', async () => {
    writeOutputs(`${COMMENT}\ntoken=sk-abcdefghijklmnop1234\n`);
    const { fetchImpl, calls } = mockFetch();

    const outcome = await runWriteBack({ env: env(), dirs, fetchImpl });

    expect(outcome.action).toBe('blocked');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    const posted = calls[1]?.body as { body?: string } | undefined;
    expect(posted?.body).toContain('已被拦截');
    expect(posted?.body).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('分析阶段的 secret_scan 命中同样阻断', async () => {
    writeOutputs(COMMENT, { secret_scan: { ok: false, hits: ['a.log'], failed: [] } });
    const { fetchImpl, calls } = mockFetch();

    const outcome = await runWriteBack({ env: env(), dirs, fetchImpl });

    expect(outcome.action).toBe('blocked');
    expect(outcome.reason).toBe('secret_scan');
    // 只发一条拦截说明
    expect(calls.filter((call) => call.method === 'PATCH' || call.method === 'POST')).toHaveLength(1);
  });

  it('bot:stop 时只发停止说明', async () => {
    writeOutputs(COMMENT);
    const { fetchImpl, calls } = mockFetch({ issue: { labels: [{ name: 'bot:stop' }] } });

    const outcome = await runWriteBack({ env: env(), dirs, fetchImpl });

    expect(outcome.action).toBe('stopped');
    const published = calls.find((call) => call.method === 'PATCH' || call.method === 'POST');
    const body = String((published?.body as { body?: string } | undefined)?.body ?? '');
    expect(body).toContain('bot:stop');
    expect(body).toContain('<!-- bot:v1:failed');
  });

  it('DRY_RUN 不发任何请求', async () => {
    writeOutputs(COMMENT);
    const { fetchImpl, calls } = mockFetch();

    const outcome = await runWriteBack({ env: env({ DRY_RUN: 'true' }), dirs, fetchImpl });

    expect(outcome.action).toBe('dry-run');
    expect(calls).toHaveLength(0);
  });

  it('没有 comment.md 时跳过', async () => {
    const { fetchImpl, calls } = mockFetch();
    const outcome = await runWriteBack({ env: env(), dirs, fetchImpl });
    expect(outcome.action).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});
