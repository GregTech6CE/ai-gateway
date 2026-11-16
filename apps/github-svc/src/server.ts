/**
 * 写回服务的 HTTP 层。
 *
 * 只暴露健康检查与 `POST /issues`；鉴权、body 上限与错误收敛和 agent-svc 共用
 * `@gt6ce/shared` 的实现。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  HttpError,
  bearerToken,
  methodNotAllowed,
  readJsonBody,
  requestUrl,
  tokensMatch,
  writeError,
  writeJson,
  type Logger,
} from '@gt6ce/shared';

import type { GitHubSvcConfig } from './config.ts';
import { CreateIssueRequestSchema } from './contracts.ts';
import { IssueService, IssueServiceError } from './issues.ts';

const MAX_BODY_BYTES = 512 * 1024;

export interface GitHubSvcDeps {
  readonly config: GitHubSvcConfig;
  readonly issues: IssueService;
  readonly logger: Logger;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

function authorized(request: IncomingMessage, expected: string): boolean {
  return tokensMatch(bearerToken(request.headers.authorization), expected);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  deps: GitHubSvcDeps,
): Promise<void> {
  const url = requestUrl(request);

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

  if (url.pathname === '/issues') {
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const parsed = CreateIssueRequestSchema.safeParse(body);
    if (!parsed.success) {
      writeError(response, 400, '请求体不符合契约', 'invalid_body');
      return;
    }
    const outcome = await deps.issues.create(parsed.data);
    deps.logger.info(outcome.replayed ? '命中幂等缓存' : 'Issue 已创建', {
      repo: parsed.data.repo,
      requestId: parsed.data.requestId,
      number: outcome.issue.number,
    });
    writeJson(response, outcome.replayed ? 200 : 201, outcome.issue);
    return;
  }

  writeError(response, 404, '接口不存在', 'not_found');
}

function handleError(error: unknown, response: ServerResponse, logger: Logger): void {
  if (error instanceof HttpError || error instanceof IssueServiceError) {
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

export function createGitHubSvcHandler(deps: GitHubSvcDeps): RequestHandler {
  return async (request, response) => {
    try {
      await route(request, response, deps);
    } catch (error) {
      handleError(error, response, deps.logger);
    }
  };
}

export function createGitHubSvcServer(deps: GitHubSvcDeps): Server {
  const handler = createGitHubSvcHandler(deps);
  return createServer((request, response) => {
    void handler(request, response);
  });
}
