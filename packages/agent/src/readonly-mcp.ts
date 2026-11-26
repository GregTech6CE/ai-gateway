/**
 * 零第三方依赖的 stdio JSON-RPC 2.0 MCP Server（`gt6-readonly`）。
 *
 * 暴露统一的 5 个只读工具：`list_files`、`grep_search`、`read_file`、`git_log`、`git_diff`，
 * 全部标注只读/非破坏/幂等/非开放世界，复用 `readonly-tools.ts` 的多根目录边界与有界执行器。
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  DEFAULT_GIT_LOG_MAX_COUNT,
  DEFAULT_GREP_MAX_MATCHES,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_READ_LIMIT,
  MAX_GIT_LOG_COUNT,
  MAX_GREP_CONTEXT_LINES,
  MAX_GREP_MATCHES,
  MAX_LIST_ENTRIES,
  MAX_READ_LIMIT,
  ToolError,
  gitDiffTool,
  gitLogTool,
  grepSearchTool,
  listFilesTool,
  readFileTool,
  rootsFromWorkspace,
  type ReadonlyRoots,
  type ReadonlyToolExecOptions,
} from './readonly-tools.ts';

export { rootsFromWorkspace, type ReadonlyRoots };

export const READONLY_MCP_SERVER_NAME = 'gt6-readonly';
export const READONLY_MCP_SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

export interface McpToolAnnotations {
  readonly readOnlyHint: true;
  readonly destructiveHint: false;
  readonly idempotentHint: true;
  readonly openWorldHint: false;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: McpToolAnnotations;
}

const READONLY_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const READONLY_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'list_files',
    description:
      '列出允许目录（code/、inputs/、outputs/）内的文件；默认 path 为 code/current，支持可选 glob 与 max_entries（默认 200，上限 500）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          default: 'code/current',
          description: '相对工作区的目录路径（须位于 code/、inputs/ 或 outputs/ 下）',
        },
        glob: {
          type: 'string',
          description: '可选文件名 glob 过滤（如 *.java、**/*.json），禁止以 - 开头',
        },
        max_entries: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_ENTRIES,
          default: DEFAULT_LIST_MAX_ENTRIES,
          description: '最多返回条目数',
        },
      },
    },
    annotations: READONLY_ANNOTATIONS,
  },
  {
    name: 'grep_search',
    description:
      '在允许目录（code/、inputs/、outputs/）内按大小写不敏感正则搜索文本；支持 glob、files_only、context_lines（0–5）与 max_matches（默认 60，上限 100）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: '正则表达式',
        },
        path: {
          type: 'string',
          default: 'code/current',
          description: '搜索起点（须位于 code/、inputs/ 或 outputs/ 下）',
        },
        glob: {
          type: 'string',
          description: '可选文件名 glob 过滤，禁止以 - 开头',
        },
        files_only: {
          type: 'boolean',
          default: false,
          description: '为 true 时只返回命中文件路径列表',
        },
        context_lines: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_GREP_CONTEXT_LINES,
          default: 0,
          description: '每条命中前后附带的上下文行数（0–5）',
        },
        max_matches: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_GREP_MATCHES,
          default: DEFAULT_GREP_MAX_MATCHES,
          description: '最多返回命中数',
        },
      },
    },
    annotations: READONLY_ANNOTATIONS,
  },
  {
    name: 'read_file',
    description:
      '按行读取允许目录（code/、inputs/、outputs/）内的文本文件，返回带行号文本与 total_lines；拒绝二进制与超大文件。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: '相对工作区的文件路径（须位于 code/、inputs/ 或 outputs/ 下）',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          default: 1,
          description: '起始行号（1 起）',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_READ_LIMIT,
          default: DEFAULT_READ_LIMIT,
          description: '最多读取行数（默认 200，上限 500）',
        },
      },
    },
    annotations: READONLY_ANNOTATIONS,
  },
  {
    name: 'git_log',
    description:
      '查看仓库提交历史（默认 code/current），支持按 path、ref、grep 过滤，默认最多 10 条（上限 30）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: {
          type: 'string',
          default: 'code/current',
          description: '仓库目录路径（须位于 code/、inputs/ 或 outputs/ 下）',
        },
        path: {
          type: 'string',
          description: '可选仓库内相对路径过滤',
        },
        ref: {
          type: 'string',
          description: '可选 git ref 或区间（禁止以 - 开头）',
        },
        grep: {
          type: 'string',
          description: '可选提交信息关键字过滤',
        },
        max_count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_GIT_LOG_COUNT,
          default: DEFAULT_GIT_LOG_MAX_COUNT,
          description: '最多返回提交数',
        },
      },
    },
    annotations: READONLY_ANNOTATIONS,
  },
  {
    name: 'git_diff',
    description:
      '查看两个 ref 之间的差异（base/head）或单次提交改动（commit），支持可选 path 与 stat_only。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: {
          type: 'string',
          default: 'code/current',
          description: '仓库目录路径（须位于 code/、inputs/ 或 outputs/ 下）',
        },
        base: {
          type: 'string',
          description: '对比基线 ref（禁止以 - 开头）',
        },
        head: {
          type: 'string',
          description: '对比目标 ref（与 base 配合使用，禁止以 - 开头）',
        },
        commit: {
          type: 'string',
          description: '查看单次提交改动（与 base/head 互斥，禁止以 - 开头）',
        },
        path: {
          type: 'string',
          description: '可选仓库内相对路径过滤',
        },
        stat_only: {
          type: 'boolean',
          default: false,
          description: '为 true 时只输出 diffstat 概要',
        },
      },
    },
    annotations: READONLY_ANNOTATIONS,
  },
];

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ToolError(`参数 ${key} 必须是字符串`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new ToolError(`缺少或非法的字符串参数: ${key}`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new ToolError(`参数 ${key} 必须是数字`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ToolError(`参数 ${key} 必须是布尔值`);
  }
  return value;
}

function rpcId(value: unknown): JsonRpcId | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return undefined;
}

function okResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResultPayload(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export interface ReadonlyMcpServerOptions {
  readonly roots: ReadonlyRoots | string;
  readonly execOptions?: ReadonlyToolExecOptions;
  readonly input?: Readable;
  readonly output?: Writable;
}

/** 创建无状态 JSON-RPC 2.0 请求处理器，便于单测直接验证协议与工具调用。 */
export function createReadonlyMcpHandler(
  roots: ReadonlyRoots | string,
  execOptions: ReadonlyToolExecOptions = {},
): (raw: unknown) => Promise<JsonRpcResponse | undefined> {
  return async (raw: unknown): Promise<JsonRpcResponse | undefined> => {
    if (!isRecord(raw)) {
      return errorResponse(null, -32600, 'Invalid Request');
    }
    const request = raw as JsonRpcRequest;
    const id = rpcId(request.id);
    const hasId = 'id' in request && id !== undefined;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return hasId ? errorResponse(id, -32600, 'Invalid Request') : undefined;
    }

    const method = request.method;
    const params = isRecord(request.params) ? request.params : {};

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return undefined;
    }
    if (!hasId) {
      return undefined;
    }

    if (method === 'initialize') {
      const requestedVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      return okResponse(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: READONLY_MCP_SERVER_NAME,
          version: READONLY_MCP_SERVER_VERSION,
        },
      });
    }

    if (method === 'ping') {
      return okResponse(id, {});
    }

    if (method === 'tools/list') {
      return okResponse(id, { tools: READONLY_MCP_TOOLS });
    }

    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isRecord(args)) {
        return okResponse(id, toolResultPayload({ error: 'arguments 必须是对象' }, true));
      }

      try {
        let output: unknown;
        switch (name) {
          case 'list_files':
            output = await listFilesTool(
              roots,
              {
                path: optionalString(args, 'path'),
                glob: optionalString(args, 'glob'),
                max_entries: optionalNumber(args, 'max_entries'),
              },
              execOptions,
            );
            break;
          case 'grep_search':
            output = await grepSearchTool(
              roots,
              {
                pattern: requiredString(args, 'pattern'),
                path: optionalString(args, 'path'),
                glob: optionalString(args, 'glob'),
                files_only: optionalBoolean(args, 'files_only'),
                context_lines: optionalNumber(args, 'context_lines'),
                max_matches: optionalNumber(args, 'max_matches'),
              },
              execOptions,
            );
            break;
          case 'read_file':
            output = readFileTool(roots, {
              path: requiredString(args, 'path'),
              offset: optionalNumber(args, 'offset'),
              limit: optionalNumber(args, 'limit'),
            });
            break;
          case 'git_log':
            output = await gitLogTool(
              roots,
              {
                repo: optionalString(args, 'repo'),
                path: optionalString(args, 'path'),
                ref: optionalString(args, 'ref'),
                grep: optionalString(args, 'grep'),
                max_count: optionalNumber(args, 'max_count'),
              },
              execOptions,
            );
            break;
          case 'git_diff':
            output = await gitDiffTool(
              roots,
              {
                repo: optionalString(args, 'repo'),
                base: optionalString(args, 'base'),
                head: optionalString(args, 'head'),
                commit: optionalString(args, 'commit'),
                path: optionalString(args, 'path'),
                stat_only: optionalBoolean(args, 'stat_only'),
              },
              execOptions,
            );
            break;
          default:
            return errorResponse(id, -32602, `Unknown tool: ${name}`);
        }
        return okResponse(id, toolResultPayload(output));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return okResponse(id, toolResultPayload({ error: message }, true));
      }
    }

    return errorResponse(id, -32601, `Method not found: ${method}`);
  };
}

/** 启动基于换行分隔 JSON-RPC 2.0 的 stdio MCP Server。 */
export function startReadonlyMcpServer(options: ReadonlyMcpServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const handle = createReadonlyMcpHandler(options.roots, options.execOptions);
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  let chain = Promise.resolve();
  const writeResponse = (response: JsonRpcResponse): void => {
    output.write(`${JSON.stringify(response)}\n`);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    chain = chain.then(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        writeResponse(errorResponse(null, -32700, 'Parse error'));
        return;
      }
      const response = await handle(parsed);
      if (response !== undefined) {
        writeResponse(response);
      }
    });
  });

  return new Promise<void>((resolvePromise) => {
    rl.once('close', () => {
      void chain.finally(() => resolvePromise());
    });
  });
}
