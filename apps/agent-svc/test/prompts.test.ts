import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseReposConfig } from '@gt6ce/shared';
import { afterAll, describe, expect, it } from 'vitest';

import {
  allowedLabels,
  buildSystemPrompt,
  buildUserPrompt,
  loadDraftPrompt,
} from '../src/prompts.ts';
import type { AgentTaskRequest } from '../src/contracts.ts';

const dirs: string[] = [];

function tempPrompts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-svc-prompts-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'common'), { recursive: true });
  mkdirSync(join(dir, 'repos', 'gt6'), { recursive: true });
  writeFileSync(join(dir, 'common', 'draft.md'), 'COMMON PROMPT', 'utf8');
  writeFileSync(join(dir, 'repos', 'gt6', 'draft.md'), 'PROFILE PROMPT', 'utf8');
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REPOS = parseReposConfig({
  bot: { login: 'bot[bot]', mention: '@bot' },
  repos: {
    'o/r': {
      code_repo: 'o/r',
      prompt_profile: 'gt6',
      triage: { write_only: ['bug', 'crash'], label_axes: { type: ['bug'], kind: ['crash'] } },
    },
  },
});

const REQUEST: AgentTaskRequest = {
  kind: 'issue-draft',
  repo: 'o/r',
  scope: 'group:g',
  requester: 'u',
  draft: {
    title: '合成器崩溃',
    version: '1.21.1',
    steps: '打开合成器',
    expected: '正常显示',
    actual: '直接崩溃',
  },
};

describe('loadDraftPrompt', () => {
  it('优先使用仓库 profile，缺失时回落 common', () => {
    const dir = tempPrompts();
    expect(loadDraftPrompt(dir, 'gt6')).toBe('PROFILE PROMPT');
    expect(loadDraftPrompt(dir, 'missing')).toBe('COMMON PROMPT');
    expect(loadDraftPrompt(dir, undefined)).toBe('COMMON PROMPT');
  });

  it('profile 名不合法时不参与路径拼接', () => {
    const dir = tempPrompts();
    expect(loadDraftPrompt(dir, '../etc')).toBe('COMMON PROMPT');
  });

  it('两者都缺时抛配置错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-svc-empty-'));
    dirs.push(dir);
    expect(() => loadDraftPrompt(dir, undefined)).toThrowError(/common\/draft\.md/);
  });
});

describe('prompt 装配', () => {
  const repo = REPOS.repos['o/r'];
  if (!repo) {
    throw new Error('fixture repo missing');
  }
  const resolved = { ...repo, key: 'o/r', botLogin: 'bot', botMention: '@bot' };

  it('允许标签优先取六轴并去重', () => {
    expect(allowedLabels(resolved)).toEqual(['bug', 'crash']);
  });

  it('system 带上仓库事实与标签白名单', () => {
    const system = buildSystemPrompt('BASE', resolved);
    expect(system).toContain('BASE');
    expect(system).toContain('o/r');
    expect(system).toContain('bug、crash');
    expect(system).toContain('不要发明新标签');
  });

  it('user 保留原始字段与实际表现', () => {
    const user = buildUserPrompt(REQUEST);
    expect(user).toContain('合成器崩溃');
    expect(user).toContain('1.21.1');
    expect(user).toContain('打开合成器');
    expect(user).toContain('正常显示');
    expect(user).toContain('直接崩溃');
  });
});
