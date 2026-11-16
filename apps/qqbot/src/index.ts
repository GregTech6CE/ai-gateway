/**
 * `@gt6ce/qqbot-app` 的装配入口。
 *
 * 依赖方向被刻意固定为单向：
 *
 *   apps/qqbot → @gt6ce/qqbot（协议） + @gt6ce/shared（日志/配置错误） + zod
 *
 * 这里**没有** `@gt6ce/agent` 与 `@gt6ce/github`：LLM 与 GitHub 凭据都在后端服务里，
 * QQ 侧只通过两个带独立 token 的 REST 客户端发起请求。`apps/qqbot/package.json`
 * 与 tsconfig 的 `paths` 也都只声明了这两个工作区依赖，越界引用会在类型检查阶段失败。
 */
import {
  DEFAULT_CHUNK_LENGTH,
  createGateway,
  type FatalDisconnect,
  type GatewayConfig,
  type QQGateway,
} from '@gt6ce/qqbot';
import { createLogger, type Logger } from '@gt6ce/shared';

import { indexBindings, type QQBotConfig } from './config.ts';
import type { IssueServices } from './handlers/types.ts';
import {
  AgentRpcClient,
  GitHubWriterRpcClient,
  type AgentGateway,
  type IssueWriter,
} from './rpc-clients.ts';
import { CommandRouter, type DispatchOutcome } from './router.ts';

export interface CreateAppOptions {
  readonly config: QQBotConfig;
  readonly logger?: Logger;
  /** 测试注入；省略时使用真实网关。 */
  readonly gateway?: QQGateway;
  readonly agent?: AgentGateway;
  readonly writer?: IssueWriter;
  /** 网关出现不可恢复关闭时回调；`main.ts` 用它触发退出。 */
  readonly onFatal?: (event: FatalDisconnect) => void;
}

export interface QQBotApp {
  readonly gateway: QQGateway;
  readonly router: CommandRouter;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const DRAIN_TIMEOUT_MS = 10_000;

function gatewayConfig(config: QQBotConfig): GatewayConfig {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    sandbox: config.sandbox,
    stateDir: config.stateDir,
    markdownSupport: true,
    chunkLength: DEFAULT_CHUNK_LENGTH,
  };
}

/** 组装网关、RPC 客户端与路由器。 */
export function createApp(options: CreateAppOptions): QQBotApp {
  const config = options.config;
  const logger = options.logger ?? createLogger({ scope: 'qqbot' });
  const gateway =
    options.gateway ?? createGateway({ config: gatewayConfig(config), logger: logger.child('gateway') });

  const services: IssueServices = {
    agent:
      options.agent ??
      new AgentRpcClient({ endpoint: config.agentEndpoint, token: config.agentToken }),
    writer:
      options.writer ??
      new GitHubWriterRpcClient({
        endpoint: config.githubWriterEndpoint,
        token: config.githubWriterToken,
      }),
    pollIntervalMs: config.pollIntervalMs,
    taskTimeoutMs: config.taskTimeoutMs,
  };

  const router = new CommandRouter({
    bindings: indexBindings(config.bindings),
    replier: gateway,
    services,
    logger: logger.child('router'),
    sessionTtlMs: config.sessionTtlMs,
  });

  const unsubscribers: Array<() => void> = [];
  let started = false;
  let stopped = false;

  return {
    gateway,
    router,

    async start(): Promise<void> {
      if (started) {
        return;
      }
      started = true;
      unsubscribers.push(
        gateway.onMessage(async (message) => {
          const outcome: DispatchOutcome = await router.handle(message);
          logger.debug('消息处理完成', {
            messageId: message.id,
            action: outcome.action,
            ...(outcome.command ? { command: outcome.command } : {}),
            ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
          });
        }),
      );
      unsubscribers.push(
        gateway.onError((error) => {
          logger.error('网关错误', { error });
        }),
      );
      unsubscribers.push(
        gateway.onFatal((event) => {
          logger.error('网关不可恢复关闭', { code: event.code, reason: event.reason });
          options.onFatal?.(event);
        }),
      );
      await gateway.start();
      logger.info('QQ 机器人已启动', {
        bindings: config.bindings.length,
        sandbox: config.sandbox,
        stateDir: config.stateDir,
      });
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const unsubscribe of unsubscribers.splice(0)) {
        unsubscribe();
      }
      await drain(router, logger);
      await gateway.stop();
    },
  };
}

/**
 * 等待后台任务收尾，但有上限：停机不能被一个卡住的轮询永久拖住。
 * 未完成的任务会随进程退出一起消失，Issue 是否创建以 GitHub 侧为准。
 */
async function drain(router: CommandRouter, logger: Logger): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS);
  });
  const result = await Promise.race([
    router.whenIdle().then(() => 'idle' as const),
    timeout,
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (result === 'timeout') {
    logger.warn('等待后台任务超时，继续停机', { timeoutMs: DRAIN_TIMEOUT_MS });
  }
}

export { CommandRouter, createDefaultRegistry, parseCommand } from './router.ts';
export type { DispatchAction, DispatchOutcome, Replier, RouterOptions } from './router.ts';
export {
  canonicalScope,
  indexBindings,
  loadConfig,
  parseConfig,
  type Binding,
  type CommandName,
  type QQBotConfig,
} from './config.ts';
export {
  AgentRpcClient,
  AgentTaskRequestSchema,
  AgentTaskSnapshotSchema,
  CreateIssueRequestSchema,
  CreatedIssueSchema,
  GitHubWriterRpcClient,
  IssueDraftInputSchema,
  IssueDraftSchema,
  RpcError,
  RpcTaskError,
  type AgentGateway,
  type AgentRpcClientOptions,
  type AgentTaskRequest,
  type AgentTaskSnapshot,
  type CreateIssueRequest,
  type CreatedIssue,
  type FetchLike,
  type GitHubWriterRpcClientOptions,
  type IssueDraft,
  type IssueDraftInput,
  type IssueWriter,
  type WaitOptions,
} from './rpc-clients.ts';
export { MessageDedupe, SessionStore, messageKey, refKey } from './stores.ts';
export type {
  DraftField,
  DraftFields,
  MessageDedupeOptions,
  Session,
  SessionStatus,
  SessionStoreOptions,
} from './stores.ts';
export {
  BOT_STOP_MARKER,
  ISSUE_COMMAND,
  ISSUE_CONTINUATION,
  nextMissingField,
  normalizeTitle,
  parseFieldAssignment,
  parseIssueArguments,
  toDraftInput,
  withBotStop,
} from './handlers/issue.ts';
export { HELP_COMMAND } from './handlers/help.ts';
export { HandlerRegistry } from './handlers/registry.ts';
export type {
  CommandContext,
  CommandHandler,
  CommandRegistration,
  ContinuationContext,
  ContinuationHandler,
  HandlerOutcome,
  IssueServices,
  Responder,
} from './handlers/types.ts';

export const PACKAGE_NAME = '@gt6ce/qqbot-app';
