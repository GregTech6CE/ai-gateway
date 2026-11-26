import { defineConfig } from 'tsdown';

/**
 * 产物：
 * - `dist/index.js` + `dist/index.d.ts`：完整主入口（内联工作区依赖与外部 SDK）
 * - `dist/readonly-mcp.js` + `dist/readonly-mcp.d.ts`：零第三方依赖的 stdio MCP 子入口
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
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
    outputOptions: { codeSplitting: false },
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
    outputOptions: { codeSplitting: false },
    checks: { bundlerTimings: false },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
]);
