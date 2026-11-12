import { defineConfig } from 'tsdown';

/**
 * 单文件产物：把源码与工作区内依赖全部内联，运行期只需要 node。
 * 产物是 dist/index.js + index.js.map + index.d.ts —— package.json 的
 * main/types 都指向 dist，所以声明文件必须一起产出。
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
  dts: { sourcemap: false },
  clean: true,
  deps: { alwaysBundle: [/^@gt6ce\//] },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
