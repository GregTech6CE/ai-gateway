import { defineConfig } from 'tsdown';

/**
 * 单文件产物：把源码、工作区依赖与 zod 全部内联，运行期只需要 node。
 * 产物是 dist/index.js + index.d.ts —— package.json 的 main/types 都指向 dist，
 * 所以声明文件必须一起产出。不生成 sourcemap：产物进 release 与镜像，
 * map 会让体积翻倍，而排查靠的是日志与结构化结果，不是行号。
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
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
