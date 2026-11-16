import { defineConfig } from 'tsdown';

/**
 * 单文件产物：把源码与工作区依赖全部内联，运行期只需要 node。
 * 占位包也走同一条构建链，避免 Step 3 接入时再改工程配置。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: false,
  dts: { sourcemap: false },
  clean: true,
  deps: { alwaysBundle: [/^@gt6ce\//, /^zod(\/|$)/] },
  // 构建耗时提示是性能建议，不是错误；关掉以免 Rush 把警告当成非零退出。
  checks: { bundlerTimings: false },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
