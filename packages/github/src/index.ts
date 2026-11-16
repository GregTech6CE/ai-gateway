/**
 * `@gt6ce/github` 的公共入口：REST 客户端、标记协议、标签门禁、答案契约、
 * 渲染与写回。
 *
 * 所有网络访问都经由注入的 `token` / `fetch`；所有模板都经由参数传入。
 * 本包不在导入时读环境变量，也不建立连接。
 */
export * from './answer.ts';
export * from './attachments.ts';
export * from './bot-tag.ts';
export * from './client.ts';
export * from './labels.ts';
export * from './render.ts';
export * from './triage.ts';

export const PACKAGE_NAME = '@gt6ce/github';
