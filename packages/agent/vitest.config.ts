import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 测试直接跑工作区源码：`@gt6ce/shared` 指到 packages/shared/src。
 * 没有别名时 vitest 会解析 shared 的 dist，`rush test` 就隐含依赖先 build。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@gt6ce/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});
