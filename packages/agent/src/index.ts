/**
 * 占位入口。模型池、worktree 准备与执行器在 Step 2 落地；
 * 这里只固定包边界与对 @gt6ce/shared 的依赖方向。
 */
import { PACKAGE_NAME as SHARED_PACKAGE } from '@gt6ce/shared';

export const PACKAGE_NAME = '@gt6ce/agent';
export const DEPENDS_ON = SHARED_PACKAGE;
