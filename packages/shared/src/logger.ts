/**
 * 轻量结构化日志。
 *
 * 一行一条 JSON，字段固定为 `ts` / `level` / `scope` / `msg` 加调用方字段；
 * 整行在写出前统一过 `redactText`，调用方无需逐个字段考虑凭据泄漏。
 * 不在模块顶层读取环境变量：级别与输出由 `createLogger` 的入参决定。
 */
import { redactText } from './scan.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  readonly scope: string;
  /** 派生同级别、同输出、同密钥集的子日志器，scope 以 `.` 连接。 */
  child(scope: string): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** 低于该级别的记录直接丢弃，默认 `info`。 */
  readonly level?: LogLevel;
  readonly scope?: string;
  /** 输出目标，默认写 stdout；测试可注入收集器。 */
  readonly sink?: (line: string) => void;
  /** 需要精确脱敏的值，通常是调用方已知的凭据。 */
  readonly secrets?: readonly string[];
  /** 时间源，便于测试固定输出。 */
  readonly now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_DEPTH = 4;

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * 把任意值转成可 JSON 化的结构。
 *
 * `Error` 只保留 `name` / `message` / `stack`；循环引用与超深结构降级为固定字符串，
 * 避免一条日志因为某个字段不可序列化就整体丢失。
 */
function toSerializable(value: unknown, seen: Set<object>, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return String(value);
    default:
      break;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? '' };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);
    return value.map((item) => toSerializable(item, seen, depth + 1));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);
    if (!isPlainObject(value)) {
      return String(value);
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toSerializable(item, seen, depth + 1);
    }
    return result;
  }
  return String(value);
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  readonly scope: string;

  private readonly sink: (line: string) => void;

  private readonly secrets: readonly string[];

  private readonly now: () => Date;

  constructor(
    level: LogLevel,
    scope: string,
    sink: (line: string) => void,
    secrets: readonly string[],
    now: () => Date,
  ) {
    this.level = level;
    this.scope = scope;
    this.sink = sink;
    this.secrets = secrets;
    this.now = now;
  }

  child(scope: string): Logger {
    const childScope = this.scope ? `${this.scope}.${scope}` : scope;
    return new StructuredLogger(this.level, childScope, this.sink, this.secrets, this.now);
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      scope: this.scope,
      msg: message,
    };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = toSerializable(value, new Set<object>(), 0);
      }
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // 兜底：即便某个字段在序列化中途抛错，也要留下这条记录。
      line = JSON.stringify({
        ts: record.ts,
        level,
        scope: this.scope,
        msg: message,
        fields: '[unserializable]',
      });
    }
    this.sink(redactText(line, this.secrets));
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(
    options.level ?? 'info',
    options.scope ?? '',
    options.sink ?? defaultSink,
    options.secrets ?? [],
    options.now ?? (() => new Date()),
  );
}
