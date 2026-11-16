import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** 测试直接跑工作区源码：`rush test` 不依赖先执行 build。 */
export default defineConfig({
  resolve: {
    alias: {
      '@gt6ce/github': fileURLToPath(new URL('../../packages/github/src/index.ts', import.meta.url)),
      '@gt6ce/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
