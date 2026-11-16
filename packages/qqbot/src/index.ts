/**
 * 占位入口。QQ 网关协议适配在 Step 3 落地；
 * 这里只固定包边界与对 @gt6ce/shared 的依赖方向。
 */
import { PACKAGE_NAME as SHARED_PACKAGE } from '@gt6ce/shared';

export const PACKAGE_NAME = '@gt6ce/qqbot';
export const DEPENDS_ON = SHARED_PACKAGE;
