import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareAcpChildEnv } from '../src/vibe-env.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gt6-vibe-env-'));
  tempDirs.push(dir);
  return dir;
}

describe('prepareAcpChildEnv', () => {
  it('mistral-vibe 生成隔离 VIBE_HOME、关闭遥测并只注入 MISTRAL_API_KEY', () => {
    const cwd = workDir();
    const prepared = prepareAcpChildEnv({
      preset: 'mistral-vibe',
      apiKey: 'vibe-secret',
      apiKeyTargetEnv: 'IGNORED_FOR_PRESET',
      cwd,
      model: 'mistral-large-4-0',
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        MODEL_KEY_MISTRAL: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
      },
    });
    try {
      const home = prepared.env.VIBE_HOME;
      expect(home).toBeTruthy();
      expect(existsSync(join(home!, 'config.toml'))).toBe(true);
      const config = readFileSync(join(home!, 'config.toml'), 'utf8');
      expect(config).toContain('enable_telemetry = false');
      expect(config).toContain('enable_auto_approve = false');
      expect(config).toContain('enable_connectors = false');
      expect(config).toContain('enable_mcp = true');
      expect(config).toContain('enable_background_processes = false');
      expect(config).toContain('enable_subagents = false');
      expect(config).toContain('default_approval_policy = "ask"');
      expect(config).toContain('outside_workdir = "deny"');
      expect(config).toContain('default_agent = "readonly"');
      expect(config).toContain('active_model = "mistral-large-4-0"');
      expect(config).toContain('[tools.write_file]');
      expect(config).toContain('[tools.edit]');
      expect(config).toContain('[tools.bash]');

      const trusted = readFileSync(join(home!, 'trusted_folders.toml'), 'utf8');
      expect(trusted).toContain(JSON.stringify(resolve(cwd)));

      const agent = readFileSync(join(home!, 'agents', 'readonly.toml'), 'utf8');
      expect(agent).toContain(
        'enabled_tools = ["read_file", "skill", "gt6_readonly_list_files", "gt6_readonly_grep_search", "gt6_readonly_read_file", "gt6_readonly_git_log", "gt6_readonly_git_diff"]',
      );
      expect(agent).not.toContain('"bash"');
      expect(agent).not.toContain('"write_file"');
      expect(agent).not.toContain('"edit"');

      expect(prepared.env.MISTRAL_API_KEY).toBe('vibe-secret');
      expect(prepared.env.IGNORED_FOR_PRESET).toBeUndefined();
      expect(prepared.env.MODEL_KEY_MISTRAL).toBeUndefined();
      expect(prepared.env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      prepared.cleanup();
    }
    expect(existsSync(prepared.env.VIBE_HOME!)).toBe(false);
  });

  it('清理只读目录与只读文件，且不跟随符号链接', () => {
    const cwd = workDir();
    const external = join(cwd, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'keep.txt'), 'keep', 'utf8');

    const prepared = prepareAcpChildEnv({
      preset: 'mistral-vibe',
      cwd,
      baseEnv: { PATH: '/usr/bin' },
    });
    const home = prepared.env.VIBE_HOME;
    expect(home).toBeTruthy();

    const readonlyDir = join(home!, 'logs', 'session', 'plugins');
    mkdirSync(readonlyDir, { recursive: true });
    const readonlyFile = join(readonlyDir, 'plugin.json');
    writeFileSync(readonlyFile, '{}', 'utf8');
    chmodSync(readonlyFile, 0o444);
    chmodSync(readonlyDir, 0o555);

    const link = join(home!, 'external-link');
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    const externalMode = lstatSync(external).mode & 0o777;

    expect(() => prepared.cleanup()).not.toThrow();
    expect(existsSync(home!)).toBe(false);
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('keep');
    expect(lstatSync(external).mode & 0o777).toBe(externalMode);
  });

  it('清理无读位目录与其中的只读文件', () => {
    const cwd = workDir();
    const prepared = prepareAcpChildEnv({
      preset: 'mistral-vibe',
      cwd,
      baseEnv: { PATH: '/usr/bin' },
    });
    const home = prepared.env.VIBE_HOME;
    expect(home).toBeTruthy();

    const lockedDir = join(home!, 'locked');
    mkdirSync(lockedDir);
    writeFileSync(join(lockedDir, 'inner.txt'), 'locked', 'utf8');
    chmodSync(join(lockedDir, 'inner.txt'), 0o444);
    chmodSync(lockedDir, 0o000);

    expect(() => prepared.cleanup()).not.toThrow();
    expect(existsSync(home!)).toBe(false);
  });

  it('generic 只按 api_key_target_env 注入密钥，不创建 VIBE_HOME', () => {
    const cwd = workDir();
    const prepared = prepareAcpChildEnv({
      preset: 'generic',
      apiKey: 'generic-secret',
      apiKeyTargetEnv: 'ACP_API_KEY',
      cwd,
      baseEnv: { PATH: '/usr/bin', HOME: '/home/runner', MODEL_KEY_MISTRAL: 'must-not-leak' },
    });
    expect(prepared.env.ACP_API_KEY).toBe('generic-secret');
    expect(prepared.env.VIBE_HOME).toBeUndefined();
    expect(prepared.env.MODEL_KEY_MISTRAL).toBeUndefined();
    prepared.cleanup();
  });

  it('没有 api_key_target_env 时不注入任何密钥', () => {
    const prepared = prepareAcpChildEnv({
      preset: 'generic',
      apiKey: 'secret',
      cwd: workDir(),
      baseEnv: { PATH: '/usr/bin', HOME: '/home/runner' },
    });
    expect(Object.values(prepared.env)).not.toContain('secret');
    prepared.cleanup();
  });
});
