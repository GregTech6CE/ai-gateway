import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ConfigError, parseModelsConfig } from '@gt6ce/shared';
import { afterAll, describe, expect, it } from 'vitest';

import {
  assertModelAvailable,
  loadAgentSvcConfig,
  parseAgentSvcConfig,
} from '../src/config.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-svc-config-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = {
  auth: { token: { value: 'svc-token' } },
  paths: { config_dir: './config', prompts_dir: './prompts' },
};

describe('parseAgentSvcConfig', () => {
  it('补齐默认值并解析相对路径', () => {
    const config = parseAgentSvcConfig(BASE, '/srv/agent');

    expect(config.server).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(config.token).toBe('svc-token');
    expect(config.configDir).toBe(resolve('/srv/agent', 'config'));
    expect(config.promptsDir).toBe(resolve('/srv/agent', 'prompts'));
    expect(config.model).toMatchObject({ pool: 'shared', role: 'analysis', temperature: 0.2 });
    expect(config.tasks).toMatchObject({ concurrency: 2, maxTasks: 200 });
  });

  it('token 支持只读文件', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'token'), ' from-file \n', 'utf8');

    const config = parseAgentSvcConfig(
      { ...BASE, auth: { token: { file: 'token' } } },
      dir,
    );

    expect(config.token).toBe('from-file');
  });

  it('token 缺失或同时提供 value/file 都拒绝', () => {
    expect(() => parseAgentSvcConfig({ ...BASE, auth: { token: {} } }, '/srv')).toThrowError(
      ConfigError,
    );
    expect(() =>
      parseAgentSvcConfig(
        { ...BASE, auth: { token: { value: 'a', file: 'b' } } },
        '/srv',
      ),
    ).toThrowError(/只能提供一个/);
  });

  it('token 文件不可读时报配置错误', () => {
    expect(() =>
      parseAgentSvcConfig({ ...BASE, auth: { token: { file: 'missing' } } }, '/srv'),
    ).toThrowError(/不可读/);
  });

  it('端口与并发必须合法', () => {
    expect(() =>
      parseAgentSvcConfig({ ...BASE, server: { port: 0 } }, '/srv'),
    ).toThrowError(ConfigError);
    expect(() =>
      parseAgentSvcConfig({ ...BASE, tasks: { concurrency: 0 } }, '/srv'),
    ).toThrowError(ConfigError);
  });
});

describe('loadAgentSvcConfig', () => {
  it('从文件加载并按文件目录解析相对路径', () => {
    const dir = tempDir();
    const path = join(dir, 'agent-svc.json');
    writeFileSync(path, JSON.stringify(BASE), 'utf8');

    const config = loadAgentSvcConfig(path);

    expect(config.configDir).toBe(join(dir, 'config'));
  });

  it('文件不可读或非法 JSON 都抛 ConfigError', () => {
    expect(() => loadAgentSvcConfig(join(tmpdir(), 'missing-agent-svc.json'))).toThrowError(
      /不可读/,
    );
    const dir = tempDir();
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{oops', 'utf8');
    expect(() => loadAgentSvcConfig(path)).toThrowError(/不是合法的 JSON/);
  });
});

describe('assertModelAvailable', () => {
  const models = parseModelsConfig({
    pools: {
      shared: {
        endpoints: [
          {
            id: 'a',
            provider: 'p',
            base_url: 'https://example.test/v1',
            api_key_env: 'MODEL_KEY_A',
            model: 'm',
          },
          {
            id: 'b',
            provider: 'p',
            base_url: 'https://example.test/v1',
            api_key_env: 'MODEL_KEY_B',
            model: 'm',
          },
        ],
        roles: { analysis: [{ endpoint: 'a' }] },
      },
    },
  });

  it('有 key 时通过', () => {
    expect(() =>
      assertModelAvailable(models, 'shared', 'analysis', { MODEL_KEY_A: 'k' }),
    ).not.toThrow();
  });

  it('没有 key 时拒绝启动', () => {
    expect(() => assertModelAvailable(models, 'shared', 'analysis', {})).toThrowError(
      /没有可用的模型 key/,
    );
  });

  it('只有未绑定 endpoint 的 key 时仍拒绝', () => {
    expect(() =>
      assertModelAvailable(models, 'shared', 'analysis', { MODEL_KEY_B: 'k' }),
    ).toThrowError(/没有可用的模型 key/);
  });

  it('未声明的池或角色都拒绝', () => {
    expect(() => assertModelAvailable(models, 'missing', 'analysis', { MODEL_KEY_A: 'k' })).toThrowError(
      /未声明的模型池/,
    );
    expect(() => assertModelAvailable(models, 'shared', 'missing', { MODEL_KEY_A: 'k' })).toThrowError(
      /没有绑定角色/,
    );
  });
});
