/**
 * 确定性渲染器：不调用模型，只把结构化结论填进模板。
 *
 * 两条硬约束：
 *
 * 1. **单次扫描替换**：模板与值只扫一遍。替换进去的文本不再参与后续占位符匹配，
 *    issue 标题里写 `{{conclusion}}` 不会被展开成结论。
 * 2. **非受信任字段转义 `<!--`**：标题、正文、模型产出里出现 `<!--` 时渲染成
 *    `&lt;!--`——肉眼可见内容不变，但不再构成 HTML 注释，因而不会被 `parseBotTags`
 *    当成幂等标记。唯一受信任的占位符是尾部 `{{marker}}`，它由渲染器自己生成。
 *
 * 模板由调用方注入（`templates`），本模块不读文件系统。
 */
import type { TriageConfig } from '@gt6ce/shared';

import type { Answer, Evidence } from './answer.ts';
import { formatDoneTag, formatFailedTag, formatPendingTag } from './bot-tag.ts';
import { sanitize, type DroppedLabel } from './labels.ts';

export const MAX_COMMENT_LENGTH = 60_000;

const MAX_EVIDENCE_ITEMS = 40;

export interface RenderTemplates {
  readonly comment: string;
  readonly reject: string;
}

export interface RenderContext {
  /** 归一化后的 `owner/name`，仅用于日志与标记归属，不写进正文。 */
  readonly repoKey: string;
  /** 本次运行的唯一标识，写进 `bot:v1:` 标记。 */
  readonly runId: string;
  readonly runUrl?: string;
  readonly issueTitle?: string;
  readonly issueNumber?: number | string;
}

/** 渲染所需的仓库配置子集。 */
export interface RenderRepoConfig {
  readonly triage: TriageConfig;
}

export interface RelevanceVerdict {
  readonly relevance?: string;
  readonly reason?: string;
  readonly confidence?: number;
}

const PLACEHOLDER_PATTERN = /\{\{([a-z_0-9]+)\}\}/g;
const TRUSTED_PLACEHOLDERS: ReadonlySet<string> = new Set(['{{marker}}']);

function escapeMarkup(value: string): string {
  return value.replaceAll('<!--', '&lt;!--');
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (placeholder: string) => {
    const value = values[placeholder];
    if (value === undefined) {
      return placeholder;
    }
    return TRUSTED_PLACEHOLDERS.has(placeholder) ? value : escapeMarkup(value);
  });
}

function inline(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }
  return `\`${trimmed.replace(/^`+|`+$/g, '')}\``;
}

function bullets(items: readonly string[], empty = '未提供。'): string {
  const lines = items.map((item) => item.trim()).filter((item) => item !== '');
  return lines.map((item) => `- ${item}`).join('\n') || empty;
}

function numbered(items: readonly string[], empty = '未提供。'): string {
  const lines = items.map((item) => item.trim()).filter((item) => item !== '');
  return lines.map((item, index) => `${index + 1}. ${item}`).join('\n') || empty;
}

function evidenceBlock(items: readonly Evidence[]): string {
  const lines: string[] = [];
  for (const item of items.slice(0, MAX_EVIDENCE_ITEMS)) {
    const summary = item.summary.trim();
    if (!summary) {
      continue;
    }
    let location = '';
    if (item.file) {
      location = item.file;
      if (item.line_start !== undefined) {
        location += `:${item.line_start}`;
        if (item.line_stop !== undefined) {
          location += `-${item.line_stop}`;
        }
      }
    }
    const suffix = location ? `（${inline(location)}）` : item.ref ? `（${inline(item.ref)}）` : '';
    lines.push(`- ${summary}${suffix}`);
  }
  return lines.join('\n') || '未提供。';
}

function runLinkBlock(runUrl: string | undefined): string {
  return runUrl ? `[GitHub Action 运行记录](${runUrl})` : '';
}

function issueHeading(context: RenderContext): { readonly issue: string; readonly title: string } {
  return {
    issue: String(context.issueNumber ?? ''),
    title: (context.issueTitle ?? '').trim() || '未提供标题',
  };
}

export interface RenderAnswerOptions {
  readonly answer: Answer;
  readonly config: RenderRepoConfig;
  readonly context: RenderContext;
  readonly templates: RenderTemplates;
  /** 覆盖 `answer.partial`：超时或被截断时由调用方强制标注。 */
  readonly partial?: boolean;
  readonly onDroppedLabels?: (dropped: readonly DroppedLabel[]) => void;
}

/** 把结构化结论渲染成评论正文，尾部写 `done type=success`。 */
export function renderAnswer(options: RenderAnswerOptions): string {
  const { answer, config, context, templates } = options;
  const partial = options.partial ?? answer.partial;
  const { issue, title } = issueHeading(context);

  const sanitized = sanitize(answer.labels, answer.issue_type, config.triage);
  if (sanitized.dropped.length > 0) {
    options.onDroppedLabels?.(sanitized.dropped);
  }

  const hint = (answer.ai_fix_hint ?? '').trim();
  const versions =
    (answer.affected_versions ?? [])
      .map((item) => inline(item))
      .filter((item) => item !== '')
      .join('、') || '未确定';
  const labelText = sanitized.kept.map((item) => inline(item)).join(', ') || '无';

  const values: Record<string, string> = {
    '{{issue_number}}': issue,
    '{{issue_title}}': title,
    '{{partial_banner}}': partial
      ? '> **部分结论**：分析在时限内未完成，以下为已完成内容。\n\n'
      : '',
    '{{issue_summary}}': bullets(answer.issue_summary),
    '{{issue_type}}': inline(sanitized.issueType),
    '{{affected_versions}}': versions,
    '{{labels}}': labelText,
    '{{evidence}}': evidenceBlock(answer.evidence),
    '{{root_cause}}': answer.root_cause.trim(),
    '{{conclusion}}': answer.conclusion.trim(),
    '{{user_advice}}': bullets(answer.user_advice),
    '{{fix_plan}}': numbered(answer.fix_plan),
    '{{ai_fix_hint_block}}': hint
      ? `## 给修复 AI 的建议（可复制）\n\n<details><summary>点击此处展开</summary>\n\n\`\`\`text\n${hint}\n\`\`\`\n\n</details>\n\n`
      : '',
    '{{confidence}}': answer.confidence,
    '{{confidence_reason}}': answer.confidence_reason.trim() || '未提供。',
    '{{run_link_block}}': runLinkBlock(context.runUrl),
    '{{marker}}': formatDoneTag(context.runId, 'success'),
  };

  const rendered = fill(templates.comment, values);
  if (rendered.length <= MAX_COMMENT_LENGTH) {
    return rendered;
  }
  return buildOversizeComment(title, issue, values['{{conclusion}}'] ?? '', context);
}

/** 超长时只保留结论与运行链接，完整证据留在 artifact。 */
function buildOversizeComment(
  title: string,
  issue: string,
  conclusion: string,
  context: RenderContext,
): string {
  const parts = [
    '## Issue 概要',
    '',
    `标题：${escapeMarkup(title)} (#${issue})`,
    '',
    '## 结论',
    '',
    escapeMarkup(conclusion),
    '',
    '> 评论过长，完整证据与修复方案见运行 artifact。',
    '',
  ];
  if (context.runUrl) {
    parts.push(`[GitHub Action 运行记录](${context.runUrl})`, '');
  }
  parts.push(formatDoneTag(context.runId, 'success'));
  return `${parts.join('\n')}\n`;
}

export interface RenderMarkdownOptions {
  readonly markdown: string;
  readonly reason: string;
  readonly context: RenderContext;
}

/**
 * 模型只产出 markdown（结构化结果缺失或非法）时的降级渲染。
 *
 * 超长时截断正文而不是整段文本：标记在尾部，直接切整段会把它切掉，
 * 下一轮被动触发就看不到 `done`，同一个 issue 会被反复唤醒。
 */
export function renderMarkdown(options: RenderMarkdownOptions): string {
  const { issue, title } = issueHeading(options.context);
  const header = [
    '## Issue 概要',
    '',
    `标题：${escapeMarkup(title)} (#${issue})`,
    '',
    `> **部分结论**：${options.reason}，以下为已完成内容。`,
    '',
  ].join('\n');

  const footerParts: string[] = [];
  if (options.context.runUrl) {
    footerParts.push('', '---', '', `[GitHub Action 运行记录](${options.context.runUrl})`);
  }
  footerParts.push('', formatDoneTag(options.context.runId, 'success'));
  const footer = footerParts.join('\n');

  const body = escapeMarkup(options.markdown.trim());
  const room = MAX_COMMENT_LENGTH - header.length - footer.length - 32;
  const clipped =
    body.length > room
      ? `${body.slice(0, Math.max(0, room))}\n\n> 正文过长，已截断。`
      : body;
  return `${header}${clipped}${footer}\n`;
}

export interface RenderRejectionOptions {
  readonly relevance: RelevanceVerdict;
  readonly context: RenderContext;
  readonly templates: RenderTemplates;
}

const REJECT_CATEGORIES: Readonly<Record<string, string>> = {
  spam: '垃圾信息、未知链接或广告',
  out_of_scope:
    '与项目内容完全无关，或要求生成与项目完全无关的图片、视频、网页、三维模型',
};

/** 相关性判定为拒收时的评论，尾部写 `done type=rejected`。 */
export function renderRejection(options: RenderRejectionOptions): string {
  const { relevance, context, templates } = options;
  const { issue, title } = issueHeading(context);
  // 分类与原因都来自模型：限长后再入模板，避免把尾部标记挤出长度上限。
  const category = (relevance.relevance ?? 'unknown').slice(0, 80);
  const label = REJECT_CATEGORIES[category] ?? category;
  const reason = (relevance.reason ?? '未提供原因').trim().slice(0, 2000);
  const rawConfidence = relevance.confidence;
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) ? rawConfidence : 0;

  const values: Record<string, string> = {
    '{{issue_number}}': issue,
    '{{issue_title}}': title,
    '{{relevance_label}}': label,
    '{{reason_block}}': `> 原因：${reason}\n\n> 分类：\`${category}\`，置信度：${confidence.toFixed(2)}`,
    '{{run_link_block}}': runLinkBlock(context.runUrl),
    '{{marker}}': formatDoneTag(context.runId, 'rejected'),
  };
  return fill(templates.reject, values);
}

export interface RenderFailureOptions {
  readonly reason?: string;
  readonly context: RenderContext;
}

/** 异常收尾：尾部写 `failed`，不阻断后续被动重试。 */
export function renderFailure(options: RenderFailureOptions): string {
  const { issue, title } = issueHeading(options.context);
  const detail = (options.reason ?? '').trim();
  const suffix = detail ? `（${detail}）` : '';
  const parts = [
    '## Issue 概要',
    '',
    `标题：${escapeMarkup(title)} (#${issue})`,
    '',
    `分析未能完成${suffix}。可以稍后重新触发，或由维护者手动查看运行记录。`,
    '',
  ];
  if (options.context.runUrl) {
    parts.push(`[GitHub Action 运行记录](${options.context.runUrl})`, '');
  }
  parts.push(formatFailedTag(options.context.runId));
  return `${parts.join('\n')}\n`;
}

/**
 * 占位评论正文，尾部写 `pending run=<id>`。
 *
 * 占位评论由调用方（A 侧）创建，`finalize` 用 PATCH 把它替换成最终结论；
 * 这里只负责标记与正文形态，保证两侧写的是同一种内容。
 */
export function renderPendingPlaceholder(context: RenderContext): string {
  return `分析任务已受理，结果会更新到本条评论。\n\n${formatPendingTag(context.runId)}\n`;
}
