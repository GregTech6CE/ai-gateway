/**
 * `@gt6ce/github-svc` 的公共入口。
 *
 * 依赖方向固定为 `@gt6ce/github` + `@gt6ce/shared` + `zod`：服务不接触模型 key，
 * 也不引入 `@gt6ce/agent` / `@gt6ce/qqbot`。
 */
export { GitHubSvcConfigSchema, loadGitHubSvcConfig, parseGitHubSvcConfig } from './config.ts';
export type { GitHubAuthConfig, GitHubSvcConfig } from './config.ts';
export { CreateIssueRequestSchema, CreatedIssueSchema } from './contracts.ts';
export type { CreateIssueOutcome, CreateIssueRequest, CreatedIssue } from './contracts.ts';
export {
  AppTokenProvider,
  GitHubAuthError,
  StaticTokenProvider,
  createAppJwt,
  createTokenProvider,
} from './github-auth.ts';
export type { AppTokenProviderOptions, TokenProvider } from './github-auth.ts';
export { IdempotencyCache } from './idempotency.ts';
export type { IdempotencyCacheOptions } from './idempotency.ts';
export { IssueService, IssueServiceError, resolveLabels } from './issues.ts';
export type { IssueServiceDeps } from './issues.ts';
export { createGitHubSvcHandler, createGitHubSvcServer } from './server.ts';
export type { GitHubSvcDeps, RequestHandler } from './server.ts';

export const PACKAGE_NAME = '@gt6ce/github-svc';
