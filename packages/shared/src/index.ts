/**
 * `@gt6ce/shared` 的公共入口：错误类型、配置契约、扫描脱敏与结构化日志。
 *
 * 本包只提供纯函数与显式 I/O 的加载器：不在模块顶层读环境变量，不发网络请求。
 */
export * from './config.ts';
export * from './errors.ts';
export * from './logger.ts';
export * from './scan.ts';

export const PACKAGE_NAME = '@gt6ce/shared';
