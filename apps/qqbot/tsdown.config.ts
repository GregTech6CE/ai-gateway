import { defineConfig } from 'tsdown';

/**
 * 两个入口：
 * - `dist/index.js`：库形态，导出 `createApp` 与各 Handler，供测试/嵌入使用；
 * - `dist/main.js`：常驻进程入口，`node dist/main.js` 直接起机器人。
 *
 * 工作区依赖（`@gt6ce/qqbot` 与 `@gt6ce/shared`）与 QQ SDK 全部内联，运行期只需要
 * node；多入口会产出共享 chunk，部署时整目录拷贝即可。不生成 sourcemap：产物进镜像，
 * map 会让体积翻倍，而排查靠日志与结构化结果，不是行号。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: false,
  // 应用不发布类型声明：SDK 的 `declare module` 会迫使产物保留一条对
  // `@tencent-connect/qqbot-nodejs` 的副作用 import，而本应用并未声明该依赖。
  // 上层要复用装配逻辑时直接引 `src/index.ts`（测试即如此）。
  dts: false,
  clean: true,
  deps: { alwaysBundle: [/^@gt6ce\//, /^@tencent-connect\//, /^zod(\/|$)/] },
  // 构建耗时提示是性能建议，不是错误；关掉以免 Rush 把警告当成非零退出。
  checks: { bundlerTimings: false },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
