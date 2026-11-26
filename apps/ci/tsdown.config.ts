import { defineConfig } from 'tsdown';

/**
 * 多入口产物：
 * - `dist/jobs/<name>.js` 与 `dist/index.js`：CI 各阶段 CLI（共享 chunk 落在 `dist/` 根目录）
 * - `dist/readonly-mcp.js`：零第三方依赖、完全自包含的单文件 stdio MCP Server
 *
 * 所有依赖全部内联，运行期只需要 node —— 发布包 `gt6-ci-<sha>.tgz` 整目录打包 `dist/`。
 */
export default defineConfig([
  {
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
    checks: { bundlerTimings: false },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    entry: ['src/readonly-mcp.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    sourcemap: false,
    dts: { sourcemap: false },
    clean: false,
    deps: {
      alwaysBundle: [/^@gt6ce\//],
    },
    outputOptions: { codeSplitting: false },
    checks: { bundlerTimings: false },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
]);
