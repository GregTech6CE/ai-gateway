import { defineConfig } from 'tsdown';

/**
 * 多入口产物：`dist/jobs/<name>.js` 每个文件都是一个可独立执行的 CLI，
 * `dist/index.js` 是同一批入口的统一调度器。
 *
 * 所有工作区依赖、AI SDK 与 zod 全部内联，运行期只需要 node —— 工作流只上传
 * `dist/`，不安装任何 npm 包。不生成 sourcemap：产物进 artifact 与镜像，
 * map 会让体积翻倍，而排查靠的是日志与结构化结果，不是行号。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/jobs/*.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: false,
  dts: { sourcemap: false },
  clean: true,
  deps: {
    alwaysBundle: [/^@gt6ce\//, /^@agentclientprotocol\//, /^@ai-sdk\//, 'ai', /^zod(\/|$)/],
  },
  // 多入口必然分包：共享 chunk 落在 dist/ 根目录，`dist/jobs/*.js` 用相对路径引用。
  // 工作流整目录上传/下载 dist，缺一不可，不要在 artifact 里只挑单个 job 文件。
  // 构建耗时提示是性能建议，不是错误；关掉以免 Rush 把警告当成非零退出。
  checks: { bundlerTimings: false },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
