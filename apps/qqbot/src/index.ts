/**
 * 占位入口。这一步只验证工作区能安装、能打包成单文件、能被 node 直接执行。
 * 引用 @gt6ce/core 是为了让打包时真的经过 workspace 链接，而不是本地路径。
 */
import { PACKAGE_NAME as CORE_PACKAGE } from '@gt6ce/core';

export const PACKAGE_NAME = '@gt6ce/qqbot';
export const DEPENDS_ON = CORE_PACKAGE;
