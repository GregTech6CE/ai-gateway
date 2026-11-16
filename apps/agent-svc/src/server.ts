/**
 * 分析服务的 HTTP 层。
 *
 * 只用 `node:http`：三个路由、一个 Bearer 校验、一个 JSON body 上限。所有错误都收敛在
 * `handleError`，响应里只有稳定文案与错误码。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  HttpError,
  bearerToken,
  methodNotAllowed,
  readJsonBody,
  requestUrl,
  resolveRepoConfig,
  tokensMatch,
  writeError,
  writeJson,
  type Logger,
  type ReposConfig,
} from '@gt6ce/shared';

import type { AgentSvcConfig } from './config.ts';
import { AgentTaskRequestSchema } from './contracts.ts';
import type { TaskStore } from './tasks.ts';

const MAX_BODY_BYTES = 256 * 1024;

export interface AgentSvcDeps {
  readonly config: AgentSvcConfig;
  readonly repos: ReposConfig;
  readonly tasks: TaskStore;
  readonly enqueue: (taskId: string) => void;
  readonly logger: Logger;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** 仓库必须在白名单内且启用；两种情况都回 403，不区分「未登记」与「未启用」以外的细节。 */
function assertRepo(repos: ReposConfig, repo: string): string {
  let resolved;
  try {
    resolved = resolveRepoConfig(repos, repo);
  } catch {
    throw new HttpError(403, '仓库未授权', 'repo_forbidden');
  }
  if (!resolved.enabled) {
    throw new HttpError(403, '仓库未启用', 'repo_disabled');
  }
  return resolved.key;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  return tokensMatch(bearerToken(request.headers.authorization), expected);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  deps: AgentSvcDeps,
): Promise<void> {
  const url = requestUrl(request);

  // 健康检查免鉴权：Docker healthcheck 不持有 RPC token。
  if (url.pathname === '/healthz') {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    writeJson(response, 200, { ok: true });
    return;
  }

  if (!authorized(request, deps.config.token)) {
    response.setHeader('www-authenticate', 'Bearer');
    writeError(response, 401, '未认证', 'unauthorized');
    return;
  }

  if (url.pathname === '/tasks') {
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const parsed = AgentTaskRequestSchema.safeParse(body);
    if (!parsed.success) {
      writeError(response, 400, '请求体不符合契约', 'invalid_body');
      return;
    }
    const repoKey = assertRepo(deps.repos, parsed.data.repo);
    const task = deps.tasks.create(parsed.data);
    deps.enqueue(task.id);
    deps.logger.info('任务已入队', { taskId: task.id, repo: repoKey });
    writeJson(response, 202, { taskId: task.id });
    return;
  }

  const match = /^\/tasks\/([^/]+)$/.exec(url.pathname);
  if (match) {
    if (request.method !== 'GET') {
      methodNotAllowed(response, ['GET']);
      return;
    }
    const taskId = decodeURIComponent(match[1] ?? '');
    const snapshot = deps.tasks.snapshot(taskId);
    if (!snapshot) {
      writeError(response, 404, '任务不存在', 'not_found');
      return;
    }
    writeJson(response, 200, snapshot);
    return;
  }

  writeError(response, 404, '接口不存在', 'not_found');
}

function handleError(error: unknown, response: ServerResponse, logger: Logger): void {
  if (error instanceof HttpError) {
    if (!response.headersSent) {
      writeError(response, error.status, error.message, error.code);
    } else {
      response.end();
    }
    return;
  }
  logger.error('未处理的请求错误', { error });
  if (!response.headersSent) {
    writeError(response, 500, '内部错误', 'internal_error');
  } else {
    response.end();
  }
}

export function createAgentSvcHandler(deps: AgentSvcDeps): RequestHandler {
  return async (request, response) => {
    try {
      await route(request, response, deps);
    } catch (error) {
      handleError(error, response, deps.logger);
    }
  };
}

export function createAgentSvcServer(deps: AgentSvcDeps): Server {
  const handler = createAgentSvcHandler(deps);
  return createServer((request, response) => {
    void handler(request, response);
  });
}
