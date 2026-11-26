import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDoneTag } from '@gt6ce/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StageDirs } from '../src/common.ts';
import { readJsonFile } from '../src/common.ts';
import { resolveReadOnlyToken, runGate, type GateEnv } from '../src/jobs/gate.ts';

const REPO_CONFIG = fileURLToPath(new URL('../../../config', import.meta.url));
const NOW = new Date('2026-11-16T10:00:00Z');
const DAY = 86_400_000;

let root: string;
let dirs: StageDirs;

function makeDirs(): StageDirs {
  root = mkdtempSync(join(tmpdir(), 'gt6ce-gate-'));
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

function env(overrides: Partial<GateEnv> = {}): GateEnv {
  return {
    REPO: 'gregtech6ce/gregtech6',
    ISSUE: '100',
    EVENT: 'issues',
    COMMENT_ID: '',
    REQUEST_ID: '',
    FORCE: 'false',
    BOT_ENABLED: 'true',
    MODEL_HEALTH: '',
    SELF_TOKEN: 'self',
    GH_RO_TOKEN: '',
    B_REPO: 'GregTech6CE/ai-gateway',
    ...overrides,
  };
}

interface IssueOverrides {
  readonly created_at?: string;
  readonly labels?: ReadonlyArray<{ name: string }>;
  readonly state?: string;
  readonly pull_request?: unknown;
  readonly body?: string;
  readonly title?: string;
}

function issue(overrides: IssueOverrides = {}) {
  return {
    number: 100,
    title: '合成器崩溃',
    body: '### 模组版本 / Mod version\n\nv1.21.1\n',
    labels: [{ name: 'bug' }],
    state: 'open',
    created_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    updated_at: new Date(NOW.getTime() - DAY).toISOString(),
    author_association: 'NONE',
    user: { login: 'reporter', type: 'User' },
    ...overrides,
  };
}

interface CommentOverrides {
  readonly body?: string;
  readonly created_at?: string;
  readonly user?: { login: string; type: string };
}

function comment(overrides: CommentOverrides = {}) {
  return {
    id: 1,
    body: '普通评论',
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    user: { login: 'gt6ce-bot[bot]', type: 'Bot' },
    ...overrides,
  };
}

interface MockOptions {
  readonly issueData: ReturnType<typeof issue>;
  readonly comments?: ReadonlyArray<ReturnType<typeof comment>>;
  readonly targetPrivate?: boolean;
}

function mockFetch(options: MockOptions) {
  const calls: Array<{ method: string; url: string; authorization: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ method, url: input, authorization });
    const path = url.pathname;
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path.toLowerCase() === '/repos/gregtech6ce/ai-gateway') {
      return json({ private: false });
    }
    if (path.toLowerCase() === '/repos/gregtech6ce/gregtech6') {
      return json({ private: options.targetPrivate ?? false });
    }
    if (path.toLowerCase() === '/repos/gregtech6ce/gregtech6/issues/100') {
      return json(options.issueData);
    }
    if (path.toLowerCase() === '/repos/gregtech6ce/gregtech6/issues/100/comments') {
      return json(options.comments ?? []);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  dirs = makeDirs();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runGate', () => {
  it('超过 7 天的 issue 跳过被动触发', async () => {
    const { fetchImpl } = mockFetch({
      issueData: issue({ created_at: new Date(NOW.getTime() - 8 * DAY).toISOString() }),
    });
    const outcome = await runGate({
      env: env(),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(['v1.21.1']),
    });
    expect(outcome.decision).toBe('skip');
    expect(outcome.reason).toBe('issue-too-old');
    expect(readJsonFile<{ decision: string }>(join(dirs.inputs, 'verdict.json'))?.decision).toBe(
      'skip',
    );
  });

  it('碰过 done 标记后不再被动触发', async () => {
    const { fetchImpl } = mockFetch({
      issueData: issue(),
      comments: [comment({ body: `结论\n${formatDoneTag('1', 'success')}` })],
    });
    const outcome = await runGate({
      env: env(),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(),
    });
    expect(outcome.reason).toBe('done-tag');
  });

  it('force 无视标记与 7 天窗口', async () => {
    const { fetchImpl } = mockFetch({
      issueData: issue({ created_at: new Date(NOW.getTime() - 30 * DAY).toISOString() }),
      comments: [comment({ body: formatDoneTag('1', 'success') })],
    });
    const outcome = await runGate({
      env: env({ FORCE: 'true' }),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(['v1.21.1']),
    });
    expect(outcome.decision).toBe('proceed');
    expect(outcome.reason).toBe('accepted');
  });

  it('bot:stop 阻止被动触发，但 force 可以覆盖', async () => {
    const { fetchImpl } = mockFetch({
      issueData: issue({ labels: [{ name: 'bug' }, { name: 'bot:stop' }] }),
    });
    const passive = await runGate({ env: env(), dirs, fetchImpl, now: NOW, remoteTags: new Set() });
    expect(passive.reason).toBe('bot:stop');

    const forced = await runGate({
      env: env({ FORCE: 'true' }),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(),
    });
    expect(forced.decision).toBe('proceed');
  });

  it('通过后写出快照、模型池与输出', async () => {
    const { fetchImpl } = mockFetch({ issueData: issue() });
    const outcome = await runGate({
      env: env(),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(['v1.21.1']),
    });

    expect(outcome.decision).toBe('proceed');
    expect(outcome.outputs.code_repo).toBe('GregTech6CE/GregTech6');
    expect(outcome.outputs.code_refs).toBe('master v1.21.1');
    expect(outcome.outputs.code_ref).toBe('master');
    expect(outcome.outputs.cache_prefix).toBe('gt6-mirror-gregtech6ce-gregtech6');
    expect(outcome.outputs.issue_title).toBe('合成器崩溃');

    const snapshot = readJsonFile<{
      issue: { number: number; labels: string[] };
      attachments: string[];
      version_tag: string;
      code_refs: string[];
    }>(join(dirs.inputs, 'snapshot.json'));
    expect(snapshot?.issue.number).toBe(100);
    expect(snapshot?.issue.labels).toEqual(['bug']);
    expect(snapshot?.version_tag).toBe('v1.21.1');
    expect(snapshot?.code_refs).toEqual(['master', 'v1.21.1']);

    const model = readJsonFile<{ analysis_entries: Array<{ id: string }> }>(
      join(dirs.inputs, 'model.json'),
    );
    expect(model?.analysis_entries.map((entry) => entry.id)).toEqual([
      'mistral-vibe',
      'clinepass-deepseek',
    ]);
  });

  it('PR 与未登记仓库都跳过', async () => {
    const pr = mockFetch({ issueData: issue({ pull_request: { url: 'x' } }) });
    expect(
      (await runGate({ env: env(), dirs, fetchImpl: pr.fetchImpl, now: NOW })).reason,
    ).toBe('pull request, not an issue');

    const unknown = mockFetch({ issueData: issue() });
    expect(
      (
        await runGate({
          env: env({ REPO: 'other/repo' }),
          dirs,
          fetchImpl: unknown.fetchImpl,
          now: NOW,
        })
      ).reason,
    ).toContain('未登记的仓库');
  });

  it('process_only 不匹配时跳过', async () => {
    const { fetchImpl } = mockFetch({ issueData: issue({ labels: [{ name: 'enhancement' }] }) });
    const outcome = await runGate({ env: env(), dirs, fetchImpl, now: NOW });
    expect(outcome.reason).toBe('process_only not matched');
  });

  it('BOT_ENABLED=false 直接跳过', async () => {
    const { fetchImpl, calls } = mockFetch({ issueData: issue() });
    const outcome = await runGate({
      env: env({ BOT_ENABLED: 'false' }),
      dirs,
      fetchImpl,
      now: NOW,
    });
    expect(outcome.reason).toBe('BOT_ENABLED=false');
    expect(calls).toHaveLength(0);
  });

  it('GH_RO_TOKEN 为空且同仓（忽略大小写）时回退使用 SELF_TOKEN', async () => {
    const { fetchImpl, calls } = mockFetch({ issueData: issue() });
    const outcome = await runGate({
      env: env({
        REPO: 'GregTech6CE/GregTech6',
        B_REPO: 'gregtech6ce/gregtech6',
        SELF_TOKEN: 'same-repo-token',
        GH_RO_TOKEN: '',
      }),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(['v1.21.1']),
    });
    expect(outcome.decision).toBe('proceed');
    const issueCall = calls.find((call) => call.url.endsWith('/issues/100'));
    const commentsCall = calls.find((call) => call.url.includes('/issues/100/comments'));
    expect(issueCall?.authorization).toBe('Bearer same-repo-token');
    expect(commentsCall?.authorization).toBe('Bearer same-repo-token');
    expect(
      resolveReadOnlyToken({
        REPO: 'GregTech6CE/GregTech6',
        B_REPO: 'gregtech6ce/gregtech6',
        SELF_TOKEN: 'same-repo-token',
        GH_RO_TOKEN: '',
      }),
    ).toBe('same-repo-token');
  });

  it('GH_RO_TOKEN 为空且跨仓时不回退 SELF_TOKEN', async () => {
    const { fetchImpl, calls } = mockFetch({ issueData: issue() });
    const outcome = await runGate({
      env: env({
        REPO: 'gregtech6ce/gregtech6',
        B_REPO: 'GregTech6CE/ai-gateway',
        SELF_TOKEN: 'bot-repo-secret',
        GH_RO_TOKEN: '',
      }),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(['v1.21.1']),
    });
    expect(outcome.decision).toBe('proceed');
    const botRepoCall = calls.find((call) => call.url.endsWith('/repos/GregTech6CE/ai-gateway'));
    const targetRepoCall = calls.find((call) => call.url.endsWith('/repos/gregtech6ce/gregtech6'));
    const issueCall = calls.find((call) => call.url.endsWith('/issues/100'));
    expect(botRepoCall?.authorization).toBe('Bearer bot-repo-secret');
    expect(targetRepoCall?.authorization).toBeNull();
    expect(issueCall?.authorization).toBeNull();
    expect(
      resolveReadOnlyToken({
        REPO: 'gregtech6ce/gregtech6',
        B_REPO: 'GregTech6CE/ai-gateway',
        SELF_TOKEN: 'bot-repo-secret',
        GH_RO_TOKEN: '',
      }),
    ).toBe('');
  });

  it('显式提供 GH_RO_TOKEN 时优先使用而非 SELF_TOKEN', async () => {
    const { fetchImpl, calls } = mockFetch({ issueData: issue() });
    const outcome = await runGate({
      env: env({
        REPO: 'GregTech6CE/GregTech6',
        B_REPO: 'GregTech6CE/GregTech6',
        SELF_TOKEN: 'self-token',
        GH_RO_TOKEN: 'explicit-ro-token',
      }),
      dirs,
      fetchImpl,
      now: NOW,
      remoteTags: new Set(['v1.21.1']),
    });
    expect(outcome.decision).toBe('proceed');
    const issueCall = calls.find((call) => call.url.endsWith('/issues/100'));
    expect(issueCall?.authorization).toBe('Bearer explicit-ro-token');
  });
});
