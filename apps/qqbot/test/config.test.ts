import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '@gt6ce/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { canonicalScope, indexBindings, loadConfig, parseConfig } from '../src/config.ts';

const BASE = {
  appId: '102000000',
  appSecret: 'secret',
  agentEndpoint: 'http://agent:8080',
  agentToken: 'agent-token',
  githubWriterEndpoint: 'http://writer:8080',
  githubWriterToken: 'writer-token',
};

const tempDirs: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseConfig', () => {
  it('最小配置补齐默认值', () => {
    const config = parseConfig(BASE);

    expect(config).toMatchObject({
      appId: '102000000',
      sandbox: false,
      stateDir: './state',
      bindings: [],
      pollIntervalMs: 2_000,
      taskTimeoutMs: 180_000,
      sessionTtlMs: 1_800_000,
    });
  });

  it('绑定项补齐 maintainers / allowedCommands / attachBotStop', () => {
    const config = parseConfig({
      ...BASE,
      bindings: [{ scope: 'group:g-1', repo: 'owner/repo' }],
    });

    expect(config.bindings[0]).toEqual({
      scope: 'group:g-1',
      repo: 'owner/repo',
      maintainers: [],
      allowedCommands: ['help', 'issue'],
      attachBotStop: false,
    });
  });

  it('缺少必填字段时列出具体路径', () => {
    const { appSecret: _ignored, ...withoutSecret } = BASE;
    expect(() => parseConfig(withoutSecret)).toThrowError(ConfigError);
    try {
      parseConfig(withoutSecret);
    } catch (error) {
      expect((error as ConfigError).issues.join(' ')).toContain('appSecret');
    }
  });

  it('仓库必须是 owner/name 形式', () => {
    expect(() =>
      parseConfig({ ...BASE, bindings: [{ scope: 'group:g-1', repo: 'not-a-repo' }] }),
    ).toThrowError(/owner\/name/);
  });

  it('重复 scope（含裸 openid 与显式前缀）被拒绝', () => {
    expect(() =>
      parseConfig({
        ...BASE,
        bindings: [
          { scope: 'g-1', repo: 'owner/repo' },
          { scope: 'group:g-1', repo: 'owner/other' },
        ],
      }),
    ).toThrowError(/重复的 scope: group:g-1/);
  });

  it('未知字段被 strict 拒绝', () => {
    expect(() => parseConfig({ ...BASE, extra: true })).toThrowError(/Unrecognized key/);
  });

  it('endpoint 必须是合法 URL', () => {
    expect(() => parseConfig({ ...BASE, agentEndpoint: 'agent:8080' })).toThrowError(ConfigError);
  });
});

describe('loadConfig', () => {
  it('从文件加载', () => {
    const path = tempFile('config.json', JSON.stringify({ ...BASE, sandbox: true }));
    expect(loadConfig(path)).toMatchObject({ sandbox: true });
  });

  it('文件不可读时抛 ConfigError', () => {
    expect(() => loadConfig(join(tmpdir(), 'missing-qqbot-config.json'))).toThrowError(
      /配置文件不可读/,
    );
  });

  it('非法 JSON 时抛 ConfigError', () => {
    const path = tempFile('broken.json', '{ not json');
    expect(() => loadConfig(path)).toThrowError(/不是合法的 JSON/);
  });
});

describe('canonicalScope', () => {
  it('裸 openid 按群处理，显式前缀保持不变', () => {
    expect(canonicalScope('abc')).toBe('group:abc');
    expect(canonicalScope('group:abc')).toBe('group:abc');
    expect(canonicalScope('c2c:abc')).toBe('c2c:abc');
    expect(canonicalScope(' c2c:abc ')).toBe('c2c:abc');
  });

  it('未知前缀按群 openid 处理', () => {
    expect(canonicalScope('guild:abc')).toBe('group:guild:abc');
  });
});

describe('indexBindings', () => {
  const config = parseConfig({
    ...BASE,
    bindings: [{ scope: 'g-1', repo: 'owner/repo', maintainers: ['u1'] }],
  });

  it('按规范化 scope 建索引', () => {
    const index = indexBindings(config.bindings);
    expect(index.get('group:g-1')?.repo).toBe('owner/repo');
  });

  it('重复 scope 直接抛 ConfigError', () => {
    expect(() =>
      indexBindings([
        { ...config.bindings[0]!, scope: 'group:g-1' },
        { ...config.bindings[0]!, scope: 'g-1' },
      ]),
    ).toThrowError(/重复的 scope/);
  });
});
