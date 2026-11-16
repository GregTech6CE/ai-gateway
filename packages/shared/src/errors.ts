/**
 * 公共错误类型。
 *
 * 两类错误都把原因放在可判定的字段上：调用方按 `status` / `source` 分支，
 * 不再对消息文本做子串匹配。
 */

/** GitHub REST 非 2xx 响应的结构化描述。 */
export interface GitHubApiErrorInit {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly detail: string;
}

/**
 * GitHub REST 的非 2xx 响应。
 *
 * 消息文本固定为 `GitHub API {method} {path} -> {status}: {detail}`，与既有日志、
 * artifact 和历史 run 的写法保持一致，便于直接对照；分支判断请用 `status`。
 */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly detail: string;

  constructor(init: GitHubApiErrorInit) {
    super(`GitHub API ${init.method} ${init.path} -> ${init.status}: ${init.detail}`);
    this.name = 'GitHubApiError';
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.detail = init.detail;
  }
}

/**
 * 配置缺失或非法。
 *
 * 一律 fail-closed：调用方不得把 `ConfigError` 退化成「默认放行」。
 */
export class ConfigError extends Error {
  /** 出错的文件路径或配置来源，例如 `config/repos.json`。 */
  readonly source: string;
  /** 逐条校验问题；空数组表示来源不可读或不可解析。 */
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${source}: ${issues.join('; ')}` : source);
    this.name = 'ConfigError';
    this.source = source;
    this.issues = [...issues];
  }
}
