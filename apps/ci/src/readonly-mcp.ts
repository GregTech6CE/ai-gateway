/**
 * `gt6-readonly` 本地 stdio MCP Server 独立入口。
 *
 * 打包为自包含的 `apps/ci/dist/readonly-mcp.js` 随 `gt6-ci-<sha>.tgz` 分发，
 * 由 `analysis.ts` 通过 `process.execPath` 启动并挂载到 ACP 会话。
 *
 * 参数：
 *   --root <dir>                                 从单个工作区根推导 code/inputs/outputs
 *   --code <dir> --inputs <dir> --outputs <dir>  显式指定三个只读根目录
 */
import { resolve } from 'node:path';

import {
  rootsFromWorkspace,
  startReadonlyMcpServer,
  type ReadonlyRoots,
} from '@gt6ce/agent/readonly-mcp';

function parseRoots(argv: readonly string[]): ReadonlyRoots {
  let root: string | undefined;
  let code: string | undefined;
  let inputs: string | undefined;
  let outputs: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--root' && next) {
      root = next;
      index += 1;
    } else if (flag === '--code' && next) {
      code = next;
      index += 1;
    } else if (flag === '--inputs' && next) {
      inputs = next;
      index += 1;
    } else if (flag === '--outputs' && next) {
      outputs = next;
      index += 1;
    } else if (flag === '--code' || flag === '--inputs' || flag === '--outputs' || flag === '--root') {
      throw new Error(`${flag} 缺少目录参数`);
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }

  const base = rootsFromWorkspace(resolve(process.cwd(), root ?? process.env.CI_ROOT ?? '.'));
  return {
    code: code ? resolve(process.cwd(), code) : base.code,
    inputs: inputs ? resolve(process.cwd(), inputs) : base.inputs,
    outputs: outputs ? resolve(process.cwd(), outputs) : base.outputs,
  };
}

const roots = parseRoots(process.argv.slice(2));
await startReadonlyMcpServer({ roots });
