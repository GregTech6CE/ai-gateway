import { defineConfig } from 'tsdown';

/**
 * 单文件产物：把源码、工作区依赖与 QQ SDK 一起内联，运行期只需要 node。
 *
 * SDK 也被内联（含它的 `ws` 依赖），这样 `apps/qqbot` 打包时不需要在运行期
 * 解析 `@tencent-connect/qqbot-nodejs`：容器镜像里只有 dist 也能跑。
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
  deps: {
    alwaysBundle: [/^@gt6ce\//, /^@tencent-connect\//, /^zod(\/|$)/],
    // 声明文件不内联 SDK 的 d.ts：本包对外只暴露自己的协议类型，
    // 内联 SDK 的 `declare module "./types.js"` 会触发 dts 插件的相对模块警告。
    dts: { neverBundle: [/^@tencent-connect\//] },
  },
  // 构建耗时提示是性能建议，不是错误；关掉以免 Rush 把警告当成非零退出。
  checks: { bundlerTimings: false },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
