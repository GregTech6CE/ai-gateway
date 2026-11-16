import { defineConfig } from 'tsdown';

/**
 * 写回服务：`dist/index.js` 供测试/嵌入，`dist/main.js` 是容器入口。
 * `@gt6ce/*` 与 `zod` 内联；应用不发布类型声明。
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
  deps: { alwaysBundle: [/^@gt6ce\//, /^zod(\/|$)/] },
  checks: { bundlerTimings: false },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
