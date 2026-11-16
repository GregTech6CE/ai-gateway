import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 测试直接跑源码：`@gt6ce/shared` 指到 packages/shared/src。
 * 这样 `rush test` 不依赖先执行 build，单独跑本包测试也能成立。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@gt6ce/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});
