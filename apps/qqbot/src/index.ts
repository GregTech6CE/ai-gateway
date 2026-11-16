/**
 * 占位入口。这一步只验证工作区能安装、能打包成单文件、能被 node 直接执行。
 * 引用两个库包是为了让打包时真的经过 workspace 链接，而不是本地路径。
 */
import { PACKAGE_NAME as QQBOT_PACKAGE } from '@gt6ce/qqbot';
import { PACKAGE_NAME as SHARED_PACKAGE } from '@gt6ce/shared';

export const PACKAGE_NAME = '@gt6ce/qqbot-app';
export const DEPENDS_ON = [SHARED_PACKAGE, QQBOT_PACKAGE] as const;
