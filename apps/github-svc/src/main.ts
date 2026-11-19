/**
 * 常驻进程入口。
 *
 * 配置路径来自 `GITHUB_SVC_CONFIG`；白名单来自 `repos.json`。启动顺序是
 * 「配置 → 白名单 → 认证方式 → 监听」，任一步失败都退出。
 */
import { resolve } from 'node:path';

import { ConfigError, createLogger, loadReposConfig, type LogLevel } from '@gt6ce/shared';

import { loadGitHubSvcConfig } from './config.ts';
import { createTokenProvider } from './github-auth.ts';
import { IdempotencyCache } from './idempotency.ts';
import { IssueService } from './issues.ts';
import { createGitHubSvcServer } from './server.ts';

function readLogLevel(): LogLevel {
  const value = (process.env.GITHUB_SVC_LOG_LEVEL ?? '').trim();
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

async function main(): Promise<void> {
  const configPath = (process.env.GITHUB_SVC_CONFIG ?? '').trim();
  if (configPath === '') {
    process.stderr.write('缺少环境变量 GITHUB_SVC_CONFIG（指向服务配置 JSON 的路径）\n');
    process.exit(1);
  }

  const config = loadGitHubSvcConfig(configPath);
  const repos = loadReposConfig(config.configDir);
  const logger = createLogger({ level: readLogLevel(), scope: 'github-svc' });
  const tokenProvider = createTokenProvider(config.github, {
    timeoutMs: config.issues.timeoutMs,
  });
  const idempotency = new IdempotencyCache({
    ttlMs: config.issues.ttlMs,
    maxEntries: config.issues.maxEntries,
  });
  const issues = new IssueService({
    repos,
    tokenProvider,
    idempotency,
    logger,
    timeoutMs: config.issues.timeoutMs,
  });
  const server = createGitHubSvcServer({ config, issues, logger });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info('写回服务已启动', {
    host: config.server.host,
    port: config.server.port,
    authMode: config.github.mode,
    repos: Object.keys(repos.repos).length,
    configPath: resolve(configPath),
    configDir: config.configDir,
  });

  let shuttingDown = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('准备停机', { reason });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    process.exit(code);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason });
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常', { error });
    void shutdown('uncaughtException', 1);
  });
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`配置错误（${error.source}）：${error.message}\n`);
  } else {
    process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
