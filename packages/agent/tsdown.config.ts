import { defineConfig } from 'tsdown';

/**
 * 单文件产物：把源码与工作区依赖全部内联，运行期只需要 node。
 * 占位包也走同一条构建链，避免 Step 2 接入时再改工程配置。
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
  deps: { alwaysBundle: [/^@gt6ce\//, 'zod'] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
