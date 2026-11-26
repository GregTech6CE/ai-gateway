/**
 * `@gt6ce/agent` 的公共入口：模型池、工作区准备、只读工具、本地 MCP 与分析执行器。
 *
 * 本包不读环境变量、不持有 GitHub 凭据：API key 由调用方按阶段注入，模型出口只走
 * 传入的 baseURL。
 */
export * from './acp-client.ts';
export * from './analyzer.ts';
export * from './bounded-exec.ts';
export * from './draft.ts';
export * from './model-pool.ts';
export * from './readonly-mcp.ts';
export * from './readonly-tools.ts';
export { createCodeTools, type CodeToolsOptions } from './tools.ts';
export * from './vibe-env.ts';
export * from './workspace.ts';

export const PACKAGE_NAME = '@gt6ce/agent';
