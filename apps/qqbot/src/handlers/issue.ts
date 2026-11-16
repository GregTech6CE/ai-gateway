/**
 * `/issue`：多轮收集 → 结构化 → 建 Issue。
 *
 * 流程刻意保持线性，没有全局状态机：
 *
 * 1. `/issue <标题>` 建立会话，本地先补齐三个必填字段（版本 / 复现步骤 / 期望结果）；
 * 2. 缺哪个就只问哪个，机器人把提问发到群里，并把这条消息的 id / ref_idx 绑到会话；
 * 3. 用户引用这条提问回复，路由器按 ref_idx 找到会话，交给 {@link handleIssueContinuation}；
 * 4. 字段齐备后先回「已受理」，再在后台提交 agent-svc 整理正文、调用 github-writer 建单，
 *    最后把编号与链接发回群里。
 *
 * 「一次一问」是刻意的：一口气列五个问题，群里没人愿意逐条对应回答；一次只问一个，
 * 引用回复天然指明答的是哪一问。
 */
import type { Logger } from '@gt6ce/shared';

import type { IssueDraftInput } from '../rpc-clients.ts';
import { RpcError, RpcTaskError } from '../rpc-clients.ts';
import type { DraftField, DraftFields, Session, SessionStore } from '../stores.ts';
import type {
  CommandContext,
  CommandRegistration,
  ContinuationContext,
  ContinuationHandler,
  HandlerOutcome,
  IssueServices,
  Responder,
} from './types.ts';

/**
 * 与 `@gt6ce/github` 的 `bot:stop` 标记逐字一致。
 *
 * 两个包之间没有依赖（QQ 侧不能引 GitHub 侧），所以这里固化字面量；改协议时
 * 两边必须同时改，`packages/github/src/bot-tag.ts` 是另一处。
 */
export const BOT_STOP_MARKER = '<!-- bot:v1:stop -->';

type RequiredField = 'version' | 'steps' | 'expected';

const REQUIRED_FIELDS: readonly RequiredField[] = ['version', 'steps', 'expected'];

const QUESTIONS: Record<RequiredField, string> = {
  version:
    '先确认版本：你使用的 GregTech6 / 整合包版本是多少？例如 `1.21.1`。\n（直接引用本条消息回复即可）',
  steps:
    '请补充复现步骤：从启动到问题出现，按顺序写下每一步操作。\n（直接引用本条消息回复即可）',
  expected:
    '最后确认期望结果：正常情况你预期会发生什么？\n（直接引用本条消息回复即可）',
};

const FIELD_PATTERNS: ReadonlyArray<{ field: DraftField; pattern: RegExp }> = [
  { field: 'title', pattern: /^(?:标题|title)\s*[:：]\s*/i },
  { field: 'version', pattern: /^(?:版本|version)\s*[:：]\s*/i },
  { field: 'steps', pattern: /^(?:复现步骤|复现|steps?)\s*[:：]\s*/i },
  { field: 'expected', pattern: /^(?:期望结果|期望|expected)\s*[:：]\s*/i },
  { field: 'actual', pattern: /^(?:实际表现|实际|actual)\s*[:：]\s*/i },
];

const TITLE_LIMIT = 200;

const USAGE = [
  '用法：`/issue <标题>`',
  '',
  '示例：`/issue 合成器在 1.21.1 加载配方时崩溃`',
  '',
  '也可以一次写全：',
  '```',
  '/issue 合成器崩溃',
  '版本：1.21.1',
  '复现：启动游戏并打开合成器',
  '期望：正常显示配方',
  '```',
].join('\n');

/** 只保留一行、去掉列表符号与多余空白，并限制长度。 */
export function normalizeTitle(raw: string): string {
  const line = raw.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1)}…`;
}

/** 解析 `/issue` 后面的参数：支持「标签：值」行，也支持首行标题 + 其余正文。 */
export function parseIssueArguments(args: string): DraftFields {
  const parsed: Partial<Record<DraftField, string>> = {};
  const leftovers: string[] = [];

  for (const rawLine of args.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    const matched = FIELD_PATTERNS.find((entry) => entry.pattern.test(line));
    if (matched) {
      const value = line.replace(matched.pattern, '').trim();
      if (value !== '') {
        parsed[matched.field] = value;
      }
      continue;
    }
    leftovers.push(line);
  }

  const remaining = [...leftovers];
  let title = parsed.title ?? '';
  if (title === '' && remaining.length > 0) {
    title = remaining.shift() ?? '';
  }
  let steps = parsed.steps ?? '';
  const extra = remaining.join('\n');
  if (extra !== '') {
    steps = steps === '' ? extra : `${steps}\n${extra}`;
  }

  return {
    title: normalizeTitle(title),
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(steps ? { steps } : {}),
    ...(parsed.expected ? { expected: parsed.expected } : {}),
    ...(parsed.actual ? { actual: parsed.actual } : {}),
  };
}

/** 解析「字段：值」形式的补充消息；首行标题只取同一行。 */
export function parseFieldAssignment(
  text: string,
): { field: DraftField; value: string } | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  const lineBreak = trimmed.indexOf('\n');
  const firstLine = lineBreak >= 0 ? trimmed.slice(0, lineBreak) : trimmed;
  const matched = FIELD_PATTERNS.find((entry) => entry.pattern.test(firstLine));
  if (!matched) {
    return undefined;
  }
  const head = firstLine.replace(matched.pattern, '').trim();
  const rest = lineBreak >= 0 ? trimmed.slice(lineBreak + 1).trim() : '';
  const value = matched.field === 'title' ? head : [head, rest].filter((item) => item !== '').join('\n');
  if (value === '') {
    return undefined;
  }
  return { field: matched.field, value };
}

/** 下一个未填的必填字段。 */
export function nextMissingField(fields: DraftFields): RequiredField | undefined {
  return REQUIRED_FIELDS.find((field) => {
    const value = fields[field];
    return value === undefined || value.trim() === '';
  });
}

/** 附件 bot:stop 标记（幂等）。 */
export function withBotStop(body: string, attach: boolean): string {
  if (!attach) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.endsWith(BOT_STOP_MARKER) ? trimmed : `${trimmed}\n\n${BOT_STOP_MARKER}`;
}

/** 已齐备的字段转成 RPC 请求体。 */
export function toDraftInput(fields: DraftFields): IssueDraftInput {
  if (!fields.version || !fields.steps || !fields.expected) {
    throw new Error('草稿字段不完整，不能提交');
  }
  return {
    title: fields.title,
    version: fields.version,
    steps: fields.steps,
    expected: fields.expected,
    ...(fields.actual ? { actual: fields.actual } : {}),
  };
}

/** `advance` 只依赖这些能力，命令上下文与续接上下文都满足。 */
interface PipelineContext extends Responder {
  readonly log: Logger;
  readonly sessions: SessionStore;
  readonly services: IssueServices;
}

/** 补齐一个字段，或者提交。 */
async function advance(context: PipelineContext, session: Session, attachBotStop: boolean): Promise<void> {
  const missing = nextMissingField(session.fields);
  if (missing) {
    session.askField = missing;
    context.sessions.touch(session);
    const result = await context.reply(QUESTIONS[missing], { markdown: true });
    context.bindSession(session.id, result);
    context.log.info('等待用户补充字段', { sessionId: session.id, field: missing });
    return;
  }

  session.status = 'submitted';
  session.askField = undefined;
  context.sessions.touch(session);
  // 受理回执也绑定会话：用户在提交后继续引用回复时，能得到明确的「已受理」答复，
  // 而不是被当成无关引用静默丢弃。
  const acknowledgement = await context.reply(
    '已受理：正在整理标题与正文，完成后会把 Issue 链接发到群里。',
    { markdown: true },
  );
  context.bindSession(session.id, acknowledgement);
  context.runInBackground(async () => {
    await createIssue(context, session, attachBotStop);
  });
}

/** 后台链路：agent-svc 整理草稿 → github-writer 建单 → 回链接。 */
async function createIssue(
  context: PipelineContext,
  session: Session,
  attachBotStop: boolean,
): Promise<void> {
  try {
    const accepted = await context.services.agent.submit({
      kind: 'issue-draft',
      repo: session.repo,
      scope: session.scopeKey,
      requester: session.requesterId,
      draft: toDraftInput(session.fields),
    });
    context.log.info('已提交草稿整理任务', {
      sessionId: session.id,
      repo: session.repo,
      taskId: accepted.taskId,
    });

    const draft = await context.services.agent.wait(accepted.taskId, {
      intervalMs: context.services.pollIntervalMs,
      timeoutMs: context.services.taskTimeoutMs,
    });

    const issue = await context.services.writer.createIssue({
      requestId: session.id,
      repo: session.repo,
      title: draft.title,
      body: withBotStop(draft.body, attachBotStop),
      labels: draft.labels,
    });
    context.log.info('Issue 已创建', {
      sessionId: session.id,
      repo: session.repo,
      number: issue.number,
    });
    await context.reply(`已创建 Issue #${issue.number}\n${issue.url}`);
  } catch (error) {
    context.log.error('创建 Issue 失败', {
      sessionId: session.id,
      repo: session.repo,
      error,
    });
    await context.reply(`创建 Issue 失败：${failureText(error)}。稍后可以重新发送 /issue。`);
  }
}

/** 给用户看的失败原因：只给稳定分类，不回显后端响应体。 */
function failureText(error: unknown): string {
  if (error instanceof RpcTaskError) {
    return '分析任务失败或超时';
  }
  if (error instanceof RpcError) {
    return error.status === 0 ? '后端服务不可达' : `后端服务返回 HTTP ${error.status}`;
  }
  return '未预期的错误';
}

async function handleIssueCommand(context: CommandContext): Promise<HandlerOutcome> {
  const fields = parseIssueArguments(context.args);
  if (fields.title === '') {
    await context.reply(USAGE, { markdown: true });
    return { handled: false, detail: 'missing-title' };
  }
  const session = context.sessions.create({
    scopeKey: context.message.scopeKey,
    repo: context.binding.repo,
    requesterId: context.message.senderId,
    fields,
  });
  context.log.info('新建 Issue 会话', {
    sessionId: session.id,
    repo: session.repo,
    scope: session.scopeKey,
  });
  await advance(context, session, context.binding.attachBotStop);
  return { handled: true, detail: session.id };
}

async function handleIssueContinuation(context: ContinuationContext): Promise<HandlerOutcome> {
  const session = context.session;
  if (session.status === 'submitted') {
    await context.reply('这次提交已经受理过了。需要新建 Issue 请发送 /issue。');
    return { handled: true, detail: 'already-submitted' };
  }

  const text = context.message.content.trim();
  if (text === '') {
    await context.reply('没有读到内容，请再发一次。');
    return { handled: true, detail: 'empty' };
  }

  const assignment = parseFieldAssignment(text);
  const answered: DraftField = assignment?.field ?? session.askField ?? 'steps';
  if (assignment) {
    session.fields[assignment.field] = assignment.value;
  } else if (session.askField) {
    session.fields[session.askField] = text;
  } else {
    // 没有待答问题时，把内容并入复现步骤，保留上下文而不是丢掉。
    const previous = session.fields.steps;
    session.fields.steps = previous && previous !== '' ? `${previous}\n${text}` : text;
  }
  session.askField = undefined;
  context.sessions.touch(session);
  context.log.info('收到会话补充', {
    sessionId: session.id,
    field: answered,
  });
  await advance(context, session, context.binding.attachBotStop);
  return { handled: true, detail: session.id };
}

export const ISSUE_COMMAND: CommandRegistration = {
  name: 'issue',
  requiresMaintainer: true,
  summary: '在当前会话绑定的仓库创建 Issue（可引用回复补充信息）',
  usage: '/issue <标题>',
  handler: handleIssueCommand,
};

export const ISSUE_CONTINUATION: ContinuationHandler = handleIssueContinuation;
