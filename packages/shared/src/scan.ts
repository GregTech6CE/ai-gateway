/**
 * 敏感信息扫描与脱敏。
 *
 * 公开面边界：任何进入评论、日志或 artifact 的文本都要先过这里。两条通道——
 * 已知精确值（`extraSecrets`，来自调用方的真实凭据）与已知形态（正则）——
 * 互为补充：精确值比正则可靠，正则覆盖未登记的新凭据。
 */

/** 命中后写入的占位文本。 */
export const REDACTED = '[REDACTED]';

interface SecretPattern {
  /** 命中标识，用于日志与阻断说明。 */
  readonly id: string;
  /** 非全局正则：`test()` 不持有 `lastIndex`，可反复调用。 */
  readonly pattern: RegExp;
}

/** 形态明确的凭据：短前缀 + 足够长的随机体。 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'sk-', pattern: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'github_pat_', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'ghp_', pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

/**
 * PEM 私钥是块状结构：只替换头部会把 base64 主体留在正文里，因此整块匹配。
 * 缺 END 的半截块（日志被截断、粘贴不完整）一直吞到文末，宁可多删也不留主体。
 */
const PEM_BLOCK_SOURCE =
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)';

/**
 * 精确密钥按长度降序排列。
 *
 * 长值先替换，避免短值先命中把长值切碎后无法整体匹配；少于 8 个字符的值
 * 与常见单词无法区分，不参与精确替换。去重后顺序稳定。
 */
export function normalizeSecrets(extraSecrets: readonly string[] = []): string[] {
  const unique = new Set<string>();
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      unique.add(secret);
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

/**
 * 返回命中标识；空数组表示干净。
 *
 * 命中 `extraSecrets` 中任一值时给出 `exact-secret`，其余按形态给出模式标识。
 */
export function scanText(text: string, extraSecrets: readonly string[] = []): string[] {
  const hits: string[] = [];
  if (normalizeSecrets(extraSecrets).some((secret) => text.includes(secret))) {
    hits.push('exact-secret');
  }
  for (const { id, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(id);
    }
  }
  return hits;
}

/**
 * 就地脱敏：私钥块整体替换，其后是精确值与单行模式。
 *
 * 顺序不可调换——先处理块，块内的精确值随之消失，避免逐段替换留下残片。
 */
export function redactText(text: string, extraSecrets: readonly string[] = []): string {
  let out = text.replace(new RegExp(PEM_BLOCK_SOURCE, 'g'), REDACTED);
  for (const secret of normalizeSecrets(extraSecrets)) {
    out = out.replaceAll(secret, REDACTED);
  }
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, 'g'), REDACTED);
  }
  return out;
}

const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'<>]+/g;
const POSIX_HOME_PATH = /\/(?:home|Users)\/[^\s"'<>]+/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const UUID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/** 把 Windows 与 POSIX 家目录路径替换为 `<path>`。 */
export function redactPaths(text: string): string {
  return text.replace(WINDOWS_PATH, '<path>').replace(POSIX_HOME_PATH, '<path>');
}

/** 把 IPv4 地址替换为 `<ip>`。 */
export function redactIps(text: string): string {
  return text.replace(IPV4, '<ip>');
}

/** 把 UUID 替换为 `<uuid>`。 */
export function redactUuids(text: string): string {
  return text.replace(UUID, '<uuid>');
}

/**
 * 诊断文本的基础脱敏：路径、IP、UUID。
 *
 * 与 `redactText` 分开：这里处理的是「可公开但不必公开」的环境细节，
 * 凭据仍必须经过 `redactText`。
 */
export function redactDiagnostics(text: string): string {
  return redactUuids(redactIps(redactPaths(text)));
}
