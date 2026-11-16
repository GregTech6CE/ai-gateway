/**
 * 六轴标签门禁：白名单、轴归属、类型兼容与数量上限。
 *
 * `issue_type` 承载类型轴，`labels` 承载性质（kind）、领域（scope）、分流状态（status）、
 * 优先级（priority）与游戏版本（version）。类型标签不重复写入 `labels`；门禁只保留
 * 仓库配置里声明过的标签，并按轴丢弃超限项。
 *
 * 没有 `label_axes` 配置时退回 `write_only` 白名单——这是一条「配置只写了一半」的
 * 兼容路径，不是默认行为：只要声明了任一轴的取值，就按六轴模型判定。
 */
import { LABEL_AXES, type LabelAxis, type TriageConfig } from '@gt6ce/shared';

export const TYPE_AXIS: LabelAxis = 'type';
export const UNKNOWN_TYPE = 'unknown';
export const DEFAULT_TYPES: readonly string[] = ['bug', 'enhancement', 'rfc'];

export const DEFAULT_LABEL_LIMITS: Readonly<Record<LabelAxis, number>> = {
  type: 1,
  kind: 2,
  scope: 2,
  status: 1,
  priority: 1,
  version: 1,
};

/** 性质标签适用的类型；未列出的性质不做类型约束。 */
export const KIND_TYPES: Readonly<Record<string, readonly string[]>> = {
  crash: ['bug'],
  regression: ['bug'],
  perf: ['bug'],
  parity: ['bug', 'enhancement', 'rfc'],
  translation: ['bug', 'enhancement'],
  qol: ['enhancement'],
  balance: ['enhancement'],
  refactor: ['enhancement'],
};

export interface DroppedLabel {
  readonly label: string;
  readonly reason: string;
}

export interface SanitizeResult {
  readonly kept: string[];
  readonly dropped: DroppedLabel[];
  readonly issueType: string;
}

/**
 * 归一化标签文本。
 *
 * 模型偶尔写成 `scope:machine` / `priority:low`，统一成配置里的规范写法；
 * 其余空白折叠为单个空格，保证比较与输出一致。
 */
export function normalizeLabel(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.replace(/^(scope|priority)\s*:\s*/i, (_match: string, axis: string) => `${axis}: `);
}

/** 取出声明过且非空的轴；空数组的轴视同未配置。 */
export function labelAxes(triage: TriageConfig): Partial<Record<LabelAxis, string[]>> {
  const result: Partial<Record<LabelAxis, string[]>> = {};
  for (const axis of LABEL_AXES) {
    const raw = triage.label_axes[axis];
    if (!raw) {
      continue;
    }
    const values: string[] = [];
    for (const item of raw) {
      const text = normalizeLabel(item);
      if (text) {
        values.push(text);
      }
    }
    if (values.length > 0) {
      result[axis] = values;
    }
  }
  return result;
}

/** 轴上限：缺省用默认值，负值截到 0。 */
export function labelLimits(triage: TriageConfig): Record<LabelAxis, number> {
  const result: Record<LabelAxis, number> = { ...DEFAULT_LABEL_LIMITS };
  for (const axis of LABEL_AXES) {
    const value = triage.label_limits[axis];
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[axis] = Math.max(0, Math.trunc(value));
    }
  }
  return result;
}

export function typeValues(triage: TriageConfig): string[] {
  return labelAxes(triage).type ?? [...DEFAULT_TYPES];
}

export function resolveType(value: unknown, triage: TriageConfig): string {
  const text = normalizeLabel(value).toLowerCase();
  for (const item of typeValues(triage)) {
    if (item.toLowerCase() === text) {
      return item;
    }
  }
  return UNKNOWN_TYPE;
}

export function isValidType(value: unknown, triage: TriageConfig): boolean {
  const text = normalizeLabel(value).toLowerCase();
  return text === UNKNOWN_TYPE || typeValues(triage).some((item) => item.toLowerCase() === text);
}

interface LabelEntry {
  readonly axis: LabelAxis;
  readonly canonical: string;
}

function labelLookup(triage: TriageConfig): Map<string, LabelEntry> {
  const table = new Map<string, LabelEntry>();
  const axes = labelAxes(triage);
  for (const axis of LABEL_AXES) {
    for (const value of axes[axis] ?? []) {
      table.set(value.toLowerCase(), { axis, canonical: value });
    }
  }
  return table;
}

/** `write_only` 兜底：只保留白名单内的标签，不区分轴。 */
function fallback(labels: readonly string[], issueType: unknown, triage: TriageConfig): SanitizeResult {
  const allowed = new Map<string, string>();
  for (const item of triage.write_only) {
    const text = normalizeLabel(item);
    if (text) {
      allowed.set(text.toLowerCase(), text);
    }
  }
  const kept: string[] = [];
  const dropped: DroppedLabel[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const text = normalizeLabel(raw);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const canonical = allowed.get(key);
    if (canonical === undefined) {
      dropped.push({ label: text, reason: 'not_allowed' });
      continue;
    }
    kept.push(canonical);
  }
  return { kept, dropped, issueType: resolveType(issueType, triage) };
}

/**
 * 返回 `(kept, dropped, resolvedIssueType)`。
 *
 * - 不在白名单、类型标签、与类型不兼容的性质标签、超过轴上限的标签都会被丢弃。
 * - 类型标签只由 `issue_type` 表达；`labels` 里出现类型标签按重复处理。
 * - 类型无法识别时归为 `unknown`，此时性质标签一并丢弃，避免输出自相矛盾的组合。
 */
export function sanitize(
  labels: readonly string[],
  issueType: unknown,
  triage: TriageConfig,
): SanitizeResult {
  const table = labelLookup(triage);
  if (table.size === 0) {
    return fallback(labels, issueType, triage);
  }

  const resolved = resolveType(issueType, triage);
  const maximum = labelLimits(triage);
  const counts: Partial<Record<LabelAxis, number>> = {};
  const kept: string[] = [];
  const dropped: DroppedLabel[] = [];
  const seen = new Set<string>();

  for (const raw of labels) {
    const text = normalizeLabel(raw);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);

    const entry = table.get(key);
    if (entry === undefined) {
      dropped.push({ label: text, reason: 'not_allowed' });
      continue;
    }
    const { axis, canonical } = entry;
    if (axis === TYPE_AXIS) {
      dropped.push({ label: canonical, reason: 'type_in_labels' });
      continue;
    }
    if (axis === 'kind') {
      if (resolved === UNKNOWN_TYPE) {
        dropped.push({ label: canonical, reason: 'kind_without_type' });
        continue;
      }
      const allowedTypes = KIND_TYPES[canonical.toLowerCase()];
      if (allowedTypes && !allowedTypes.includes(resolved.toLowerCase())) {
        dropped.push({ label: canonical, reason: `kind_not_for_${resolved}` });
        continue;
      }
    }
    const used = counts[axis] ?? 0;
    if (used >= maximum[axis]) {
      dropped.push({ label: canonical, reason: `limit_${axis}` });
      continue;
    }
    counts[axis] = used + 1;
    kept.push(canonical);
  }

  return { kept, dropped, issueType: resolved };
}

/** 把丢弃原因压成一行，便于写进 stderr 或日志。 */
export function formatDropped(dropped: readonly DroppedLabel[]): string {
  return dropped.map((item) => `${item.label}(${item.reason})`).join(', ');
}
