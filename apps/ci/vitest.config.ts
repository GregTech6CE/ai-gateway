import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 测试直接跑 workspace 源码：三个库包都指向各自的 `src/index.ts`，
 * 这样 `rush test` 不依赖先执行 build。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@gt6ce/agent': fileURLToPath(new URL('../../packages/agent/src/index.ts', import.meta.url)),
      '@gt6ce/github': fileURLToPath(new URL('../../packages/github/src/index.ts', import.meta.url)),
      '@gt6ce/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
