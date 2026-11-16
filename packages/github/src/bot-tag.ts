/**
 * `bot:v1:` 标记协议。
 *
 * 唯一职责是控制**被动触发**（如 Issue 自动分析）：评论里出现哪种标记，决定下一轮
 * 被动事件是否还要唤起分析。标记不承担授权职责——授权仍看仓库配置与作者协会。
 *
 * 主动触发优先：`force: true`（`@bot` 显式指令、手动 `workflow_dispatch`）无视
 * 一切标记与时间窗口直接放行；`bot:v1:failed` 也不阻断重试。
 *
 * 不兼容历史的 `lily:` 标记：旧格式解析不出来即视为没有标记，由
 * `maxIssueAgeDays` 这道时间兜底拦住陈年 issue。
 */
import { DEFAULT_MAX_ISSUE_AGE_DAYS } from '@gt6ce/shared';

export type BotTagKind = 'stop' | 'pending' | 'done' | 'failed';

/** `done` 的两种终态：分析完成，或相关性判定为拒收。 */
export type DoneType = 'success' | 'rejected';

export interface BotTag {
  readonly kind: BotTagKind;
  /** `stop` 没有 run id，取空串。 */
  readonly runId: string;
  readonly doneType?: DoneType;
}

/** `pending` 超过该窗口未更新即视为过期，允许重跑。 */
export const DEFAULT_PENDING_WINDOW_MINUTES = 70;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const TAG_PATTERN = /<!--\s*bot:v1:(stop|pending|done|failed)([\s\S]*?)-->/g;
const FIELD_PATTERN = /([a-z_]+)=([^\s>]+)/g;
const UNSAFE_RUN_ID = /[^A-Za-z0-9_.:-]/g;

function normalizeRunId(runId: string): string {
  const cleaned = runId.replace(UNSAFE_RUN_ID, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

function normalizeDoneType(value: string | undefined): DoneType | undefined {
  return value === 'success' || value === 'rejected' ? value : undefined;
}

export function formatStopTag(): string {
  return '<!-- bot:v1:stop -->';
}

export function formatPendingTag(runId: string): string {
  return `<!-- bot:v1:pending run=${normalizeRunId(runId)} -->`;
}

export function formatDoneTag(runId: string, type: DoneType): string {
  return `<!-- bot:v1:done type=${type} run=${normalizeRunId(runId)} -->`;
}

export function formatFailedTag(runId: string): string {
  return `<!-- bot:v1:failed run=${normalizeRunId(runId)} -->`;
}

/**
 * 解析文本里的全部 `bot:v1:` 标记。
 *
 * 宽松解析：未知字段忽略，`done` 的 `type` 非 `success|rejected` 时仍算 `done`
 * （宁可不重复唤醒，也不因为一个坏字段把已完成的任务再跑一遍）。
 */
export function parseBotTags(text: string): BotTag[] {
  const tags: BotTag[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    const rawKind = match[1];
    if (!rawKind) {
      continue;
    }
    const kind = rawKind as BotTagKind;
    const fields = new Map<string, string>();
    for (const field of (match[2] ?? '').matchAll(FIELD_PATTERN)) {
      const key = field[1];
      const value = field[2];
      if (key && value) {
        fields.set(key, value);
      }
    }
    const doneType = kind === 'done' ? normalizeDoneType(fields.get('type')) : undefined;
    tags.push(doneType ? { kind, runId: fields.get('run') ?? '', doneType } : { kind, runId: fields.get('run') ?? '' });
  }
  return tags;
}

export type DateInput = Date | number | string;

export interface PassiveTriggerComment {
  /** 评论正文；调用方只传入 bot 自己发的评论。 */
  readonly body: string;
  /** 评论创建时间；缺失时 `pending` 一律按未过期处理。 */
  readonly createdAt?: DateInput;
}

export interface PassiveTriggerInput {
  /** 用户主动强制执行：无视全部标记与时间窗口。 */
  readonly force?: boolean;
  readonly comments?: readonly PassiveTriggerComment[];
  readonly issueCreatedAt?: DateInput;
  readonly now?: DateInput;
  readonly pendingWindowMinutes?: number;
  readonly maxIssueAgeDays?: number;
}

export type PassiveSkipReason = 'stop-tag' | 'done-tag' | 'pending' | 'issue-too-old';

export type PassiveTriggerDecision =
  | { readonly skip: false; readonly reason: 'forced' | 'eligible' }
  | { readonly skip: true; readonly reason: PassiveSkipReason };

/** 数字按毫秒时间戳解释；无法解析的时间一律当作「不知道」。 */
function toDate(value: DateInput | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isExpired(createdAt: DateInput | undefined, now: Date, windowMinutes: number): boolean {
  const created = toDate(createdAt);
  if (!created) {
    // 拿不到时间就无法证明已过期，按仍在进行中处理。
    return false;
  }
  return now.getTime() - created.getTime() > windowMinutes * MINUTE_MS;
}

/**
 * 被动触发判定。
 *
 * 顺序即语义：`force` 最先短路，其后 stop > done > pending > 超期。
 * 返回的 `reason` 可直接进日志或 `gate` 的 skip 说明。
 */
export function shouldSkipPassiveTrigger(input: PassiveTriggerInput): PassiveTriggerDecision {
  if (input.force === true) {
    return { skip: false, reason: 'forced' };
  }

  const now = toDate(input.now) ?? new Date();
  const comments = input.comments ?? [];

  const parsed = comments.flatMap((comment) => {
    const createdAt = comment.createdAt;
    return parseBotTags(comment.body).map((tag) => ({ tag, createdAt }));
  });

  if (parsed.some(({ tag }) => tag.kind === 'stop')) {
    return { skip: true, reason: 'stop-tag' };
  }
  if (parsed.some(({ tag }) => tag.kind === 'done')) {
    return { skip: true, reason: 'done-tag' };
  }

  const pendingWindowMinutes = input.pendingWindowMinutes ?? DEFAULT_PENDING_WINDOW_MINUTES;
  const hasActivePending = parsed.some(
    ({ tag, createdAt }) => tag.kind === 'pending' && !isExpired(createdAt, now, pendingWindowMinutes),
  );
  if (hasActivePending) {
    return { skip: true, reason: 'pending' };
  }

  const maxIssueAgeDays = input.maxIssueAgeDays ?? DEFAULT_MAX_ISSUE_AGE_DAYS;
  const issueCreatedAt = toDate(input.issueCreatedAt);
  if (issueCreatedAt && now.getTime() - issueCreatedAt.getTime() > maxIssueAgeDays * DAY_MS) {
    return { skip: true, reason: 'issue-too-old' };
  }

  return { skip: false, reason: 'eligible' };
}
