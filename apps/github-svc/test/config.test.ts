import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ConfigError } from '@gt6ce/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { loadGitHubSvcConfig, parseGitHubSvcConfig } from '../src/config.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'github-svc-config-'));
  dirs.push(dir);
  return dir;
}

function privateKeyPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = {
  auth: { token: { value: 'svc-token' } },
  paths: { config_dir: './config' },
  github: { mode: 'token', token: { value: 'gh-token' } },
};

describe('parseGitHubSvcConfig', () => {
  it('token 模式补齐默认值', () => {
    const config = parseGitHubSvcConfig(BASE, '/srv/github');

    expect(config.server).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(config.token).toBe('svc-token');
    expect(config.configDir).toBe(resolve('/srv/github', 'config'));
    expect(config.github).toEqual({ mode: 'token', token: 'gh-token' });
    expect(config.issues).toMatchObject({
      ttlMs: 24 * 60 * 60 * 1000,
      maxEntries: 1_000,
      timeoutMs: 15_000,
    });
  });

  it('app 模式读取私钥文件并可指定 installation id', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'app.pem'), privateKeyPem(), 'utf8');

    const config = parseGitHubSvcConfig(
      {
        ...BASE,
        github: {
          mode: 'app',
          app_id: '12345',
          private_key_file: 'app.pem',
          installation_id: 99,
        },
      },
      dir,
    );

    expect(config.github).toMatchObject({
      mode: 'app',
      appId: '12345',
      installationId: 99,
    });
    expect(config.github.mode === 'app' && config.github.privateKey).toContain('BEGIN');
  });

  it('app 私钥不是 PEM 时拒绝', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'app.pem'), 'not a key', 'utf8');

    expect(() =>
      parseGitHubSvcConfig(
        { ...BASE, github: { mode: 'app', app_id: '1', private_key_file: 'app.pem' } },
        dir,
      ),
    ).toThrowError(/PEM/);
  });

  it('凭据二选一与必填校验', () => {
    expect(() =>
      parseGitHubSvcConfig(
        { ...BASE, github: { mode: 'token', token: { value: 'a', file: 'b' } } },
        '/srv',
      ),
    ).toThrowError(/只能提供一个/);
    expect(() =>
      parseGitHubSvcConfig({ ...BASE, github: { mode: 'token' } }, '/srv'),
    ).toThrowError(ConfigError);
  });

  it('未知 mode 与未知字段都拒绝', () => {
    expect(() =>
      parseGitHubSvcConfig(
        { ...BASE, github: { mode: 'oauth', token: { value: 'x' } } },
        '/srv',
      ),
    ).toThrowError(ConfigError);
    expect(() => parseGitHubSvcConfig({ ...BASE, extra: true }, '/srv')).toThrowError(
      /Unrecognized key/,
    );
  });
});

describe('loadGitHubSvcConfig', () => {
  it('从文件加载并按目录解析相对路径', () => {
    const dir = tempDir();
    const path = join(dir, 'github-svc.json');
    writeFileSync(path, JSON.stringify(BASE), 'utf8');

    expect(loadGitHubSvcConfig(path).configDir).toBe(join(dir, 'config'));
  });

  it('不可读或非法 JSON 抛 ConfigError', () => {
    expect(() => loadGitHubSvcConfig(join(tmpdir(), 'missing-github-svc.json'))).toThrowError(
      /不可读/,
    );
    const dir = tempDir();
    const path = join(dir, 'broken.json');
    writeFileSync(path, 'nope', 'utf8');
    expect(() => loadGitHubSvcConfig(path)).toThrowError(/不是合法的 JSON/);
  });
});
