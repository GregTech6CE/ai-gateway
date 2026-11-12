import { defineConfig } from 'tsdown';

/**
 * 单文件产物：把源码与工作区内依赖全部内联，运行期只需要 node。
 * 不生成 .d.ts —— 消费方（workflow 的 job 入口）不需要类型声明，
 * 而 tsc --noEmit 直接读 src/ 做检查。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  // 不把 .ts 源码塞进 map：产物会进 release 与镜像，没必要带上源文件
  outputOptions: { sourcemapExcludeSources: true },
  dts: false,
  clean: true,
  deps: { alwaysBundle: [/^@gt6ce\//] },
  outExtensions: () => ({ js: '.js' }),
});
