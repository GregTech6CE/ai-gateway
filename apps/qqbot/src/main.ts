/**
 * 常驻进程入口。
 *
 * 职责只有三件：读配置、起应用、处理信号。所有运行参数来自 `QQBOT_CONFIG`
 * 指向的 JSON 文件；这里不解析其他业务环境变量，也不打印配置内容。
 */
import { resolve } from 'node:path';

import { ConfigError, createLogger, type LogLevel } from '@gt6ce/shared';

import { loadConfig } from './config.ts';
import { createApp, type QQBotApp } from './index.ts';

function readLogLevel(): LogLevel {
  const value = (process.env.QQBOT_LOG_LEVEL ?? '').trim();
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

const logger = createLogger({ level: readLogLevel(), scope: 'qqbot' });

let app: QQBotApp | undefined;
let shuttingDown = false;

async function shutdown(reason: string, code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('准备停机', { reason });
  try {
    await app?.stop();
  } catch (error) {
    logger.error('停机时出错', { error });
  }
  process.exit(code);
}

async function main(): Promise<void> {
  const configPath = (process.env.QQBOT_CONFIG ?? '').trim();
  if (configPath === '') {
    process.stderr.write('缺少环境变量 QQBOT_CONFIG（指向机器人配置 JSON 的路径）\n');
    process.exit(1);
  }

  const config = loadConfig(configPath);
  // 启动阶段先交代「读的是哪份配置、状态落在哪」：容器里挂错文件是最常见的故障。
  logger.info('配置已加载', {
    configPath: resolve(configPath),
    stateDir: resolve(config.stateDir),
    bindings: config.bindings.length,
    sandbox: config.sandbox,
  });
  app = createApp({
    config,
    logger,
    onFatal: (event) => {
      logger.error('网关不可恢复，退出进程', { code: event.code, reason: event.reason });
      void shutdown('gateway-fatal', 1);
    },
  });

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

  await app.start();
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
