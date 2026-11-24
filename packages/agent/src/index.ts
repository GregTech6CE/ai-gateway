/**
 * `@gt6ce/agent` 的公共入口：模型池、工作区准备、代码工具与分析执行器。
 *
 * 本包不读环境变量、不持有 GitHub 凭据：API key 由调用方按阶段注入，模型出口只走
 * 传入的 baseURL。这样 agent-svc 容器可以在没有 GitHub 权限、只有 LLM Key 的网络边界里运行。
 */
export * from './acp-client.ts';
export * from './analyzer.ts';
export * from './draft.ts';
export * from './model-pool.ts';
export * from './tools.ts';
export * from './vibe-env.ts';
export * from './workspace.ts';

export const PACKAGE_NAME = '@gt6ce/agent';
