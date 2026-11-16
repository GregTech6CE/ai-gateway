/**
 * 常驻进程入口。
 *
 * 配置路径来自 `AGENT_SVC_CONFIG`；模型 key 由容器环境注入（名称来自 `models.json` 的
 * `api_key_env`）。启动顺序是「配置 → 白名单 → 模型可用性 → 监听」，任一步失败都退出，
 * 不带着半套配置接流量。
 */
import { ConfigError, createLogger, loadBudgetsConfig, loadModelsConfig, loadReposConfig, type LogLevel } from '@gt6ce/shared';

import { assertModelAvailable, loadAgentSvcConfig } from './config.ts';
import { createDraftExecutor } from './executor.ts';
import { TaskRunner } from './runner.ts';
import { createAgentSvcServer } from './server.ts';
import { TaskStore } from './tasks.ts';

function readLogLevel(): LogLevel {
  const value = (process.env.AGENT_SVC_LOG_LEVEL ?? '').trim();
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

async function main(): Promise<void> {
  const configPath = (process.env.AGENT_SVC_CONFIG ?? '').trim();
  if (configPath === '') {
    process.stderr.write('缺少环境变量 AGENT_SVC_CONFIG（指向服务配置 JSON 的路径）\n');
    process.exit(1);
  }

  const config = loadAgentSvcConfig(configPath);
  const repos = loadReposConfig(config.configDir);
  const models = loadModelsConfig(config.configDir);
  const budgets = loadBudgetsConfig(config.configDir);
  assertModelAvailable(models, config.model.pool, config.model.role, process.env);

  const logger = createLogger({ level: readLogLevel(), scope: 'agent-svc' });
  const tasks = new TaskStore({ ttlMs: config.tasks.ttlMs, maxTasks: config.tasks.maxTasks });
  const executor = createDraftExecutor({
    repos,
    models,
    budgets,
    promptsDir: config.promptsDir,
    env: process.env,
    pool: config.model.pool,
    role: config.model.role,
    temperature: config.model.temperature,
    maxOutputTokens: config.model.maxOutputTokens,
    timeoutMs: config.model.timeoutMs,
  });
  const runner = new TaskRunner({
    store: tasks,
    executor,
    concurrency: config.tasks.concurrency,
    timeoutMs: config.tasks.timeoutMs,
    logger,
  });
  const server = createAgentSvcServer({
    config,
    repos,
    tasks,
    enqueue: (taskId) => {
      runner.enqueue(taskId);
    },
    logger,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info('分析服务已启动', {
    host: config.server.host,
    port: config.server.port,
    concurrency: config.tasks.concurrency,
    pool: config.model.pool,
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
    await runner.stop(10_000);
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
