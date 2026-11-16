import { defineConfig } from 'tsdown';

/**
 * 分析服务：`dist/index.js` 供测试/嵌入，`dist/main.js` 是容器入口。
 *
 * `@gt6ce/*`、`ai`、`@ai-sdk/*` 与 `zod` 全部内联，镜像里只需要 dist 与 node；
 * 应用不发布类型声明（`dts: false`），与 `apps/qqbot` 保持一致。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: false,
  dts: false,
  clean: true,
  deps: { alwaysBundle: [/^@gt6ce\//, /^@ai-sdk\//, 'ai', /^zod(\/|$)/] },
  checks: { bundlerTimings: false },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
