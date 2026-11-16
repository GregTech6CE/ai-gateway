/**
 * `@gt6ce/shared` 的公共入口：错误类型、配置契约、答案契约、扫描脱敏、结构化日志
 * 与内部 HTTP 服务端设施。
 *
 * 本包只提供纯函数与显式 I/O 的加载器：不在模块顶层读环境变量，不发网络请求。
 */
export * from './answer.ts';
export * from './config.ts';
export * from './errors.ts';
export * from './http.ts';
export * from './logger.ts';
export * from './rpc.ts';
export * from './scan.ts';

export const PACKAGE_NAME = '@gt6ce/shared';
