import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** 测试直接跑源码：`@gt6ce/shared` 指到 packages/shared/src，不依赖先 build。 */
export default defineConfig({
  resolve: {
    alias: {
      '@gt6ce/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});
