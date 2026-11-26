/**
 * 统一的有界流式子进程执行器。
 *
 * - `shell: false`，参数按 argv 数组直传，绝不经过 shell 解释。
 * - 子进程环境最小化：仅保留 `PATH` 与 `GIT_TERMINAL_PROMPT=0`，不继承任何密钥。
 * - 内存流式缓存上限默认 64 KB：触达上限立刻发送 `SIGTERM` 止损，宽限 1 秒后 `SIGKILL`。
 * - 默认超时 15 秒：先 `SIGTERM`，宽限 1 秒后 `SIGKILL`，保留已收到的完整行并标记
 *   `timed_out: true, truncated: true`，全过程不落盘。
 */
import { spawn } from 'node:child_process';

export const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
export const DEFAULT_KILL_GRACE_MS = 1_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export class BoundedExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedExecError';
  }
}

export interface BoundedExecOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BoundedExecResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/** 仅保留 `PATH` 与 `GIT_TERMINAL_PROMPT=0`，剔除全部密钥与多余环境变量。 */
export function minimalExecEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
  };
  const pathValue = source.PATH ?? source.Path;
  if (typeof pathValue === 'string' && pathValue !== '') {
    env.PATH = pathValue;
  }
  return env;
}

/**
 * 保留已收到的完整行，裁去末尾可能残缺的半行。
 *
 * 输出以 `\n` 结尾时原样返回；不含任何 `\n` 时说明整段输出都是未结束的半行，返回空串。
 */
export function keepCompleteLines(text: string): string {
  if (text === '' || text.endsWith('\n')) {
    return text;
  }
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
}

/** 按字节上限安全截断 Buffer，避免把多字节 UTF-8 字符从中间切开。 */
function sliceUtf8Bytes(buffer: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  if (buffer.length <= maxBytes) {
    return buffer;
  }
  let end = maxBytes;
  // 若被切掉的首字节是 UTF-8 续字节（10xxxxxx），回退到该字符起始字节之前。
  if ((buffer[end]! & 0xc0) === 0x80) {
    while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end > 0) {
      end -= 1;
    }
  }
  return buffer.subarray(0, end);
}

function finalizeTruncatedText(raw: string, timedOut: boolean): string {
  if (timedOut) {
    return keepCompleteLines(raw);
  }
  const lastNewline = raw.lastIndexOf('\n');
  return lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : raw;
}

/** 执行单个外部只读命令，强制超时、流式字节上限与最小环境变量。 */
export async function boundedExec(
  bin: string,
  args: readonly string[],
  options: BoundedExecOptions = {},
): Promise<BoundedExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env = minimalExecEnv(options.env ?? process.env);

  return await new Promise<BoundedExecResult>((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(bin, [...args], {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rejectPromise(new BoundedExecError(`启动命令失败 (${bin}): ${detail}`));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let terminating = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const terminate = (): void => {
      if (terminating || child.exitCode !== null) {
        return;
      }
      terminating = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // 子进程已退出
      }
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // 子进程已退出
          }
        }
      }, killGraceMs);
      killTimer.unref();
    };

    const appendChunk = (target: Buffer[], chunk: Buffer): void => {
      if (truncated || timedOut || chunk.length === 0) {
        return;
      }
      const remaining = maxOutputBytes - bufferedBytes;
      if (remaining <= 0) {
        truncated = true;
        terminate();
        return;
      }
      if (chunk.length > remaining) {
        const sliced = sliceUtf8Bytes(chunk, remaining);
        if (sliced.length > 0) {
          target.push(sliced);
          bufferedBytes += sliced.length;
        }
        truncated = true;
        terminate();
        return;
      }
      target.push(chunk);
      bufferedBytes += chunk.length;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      appendChunk(stdoutChunks, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendChunk(stderrChunks, chunk);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref();

    child.on('error', (error) => {
      clearTimers();
      if (settled) {
        return;
      }
      settled = true;
      rejectPromise(new BoundedExecError(`启动命令失败 (${bin}): ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimers();
      if (settled) {
        return;
      }
      settled = true;
      const rawStdout = Buffer.concat(stdoutChunks).toString('utf8');
      const rawStderr = Buffer.concat(stderrChunks).toString('utf8');
      const stdout = truncated ? finalizeTruncatedText(rawStdout, timedOut) : rawStdout;
      const stderr = truncated ? finalizeTruncatedText(rawStderr, timedOut) : rawStderr;
      resolvePromise({
        exit_code: code ?? -1,
        stdout,
        stderr,
        truncated,
        timed_out: timedOut,
      });
    });
  });
}
