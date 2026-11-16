import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 测试直接跑源码：`@gt6ce/qqbot` 与 `@gt6ce/shared` 都指到各自 `src/index.ts`，
 * 这样 `rush test` 不依赖先执行 build。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@gt6ce/qqbot': fileURLToPath(new URL('../../packages/qqbot/src/index.ts', import.meta.url)),
      '@gt6ce/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
