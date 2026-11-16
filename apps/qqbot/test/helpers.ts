/**
 * 测试替身：记录型回复器、内存版后端服务、消息工厂。
 *
 * 这些替身只实现 Handler / 路由器真正用到的方法，接口定义在 `src/rpc-clients.ts`
 * 与 `src/router.ts`，所以生产实现与测试替身共用同一份契约。
 */
import type { InboundMessage, ReplyOptions, ReplyResult, ReplyTarget } from '@gt6ce/qqbot';
import { createLogger } from '@gt6ce/shared';

import type { Binding, CommandName } from '../src/config.ts';
import type { IssueServices } from '../src/handlers/types.ts';
import type {
  AgentGateway,
  AgentTaskRequest,
  CreateIssueRequest,
  CreatedIssue,
  IssueDraft,
  IssueWriter,
  WaitOptions,
} from '../src/rpc-clients.ts';
import type { Replier } from '../src/router.ts';
import { CommandRouter } from '../src/router.ts';
import { SessionStore } from '../src/stores.ts';

export const GROUP = 'g-1';
export const MAINTAINER = 'u-maintainer';
export const OUTSIDER = 'u-outsider';

export interface SentReply {
  readonly target: ReplyTarget;
  readonly text: string;
  readonly options: ReplyOptions | undefined;
  readonly result: ReplyResult;
}

export class RecordingReplier implements Replier {
  readonly sent: SentReply[] = [];

  /** 模拟平台不回 `ext_info.ref_idx` 的情况。 */
  omitRefIndexes = false;

  private counter = 0;

  async reply(
    target: ReplyTarget,
    content: string,
    options?: ReplyOptions,
  ): Promise<ReplyResult> {
    this.counter += 1;
    const result: ReplyResult = {
      messageIds: [`bot-${this.counter}`],
      refIndexes: [this.omitRefIndexes ? undefined : `ref-${this.counter}`],
      chunks: 1,
      degraded: false,
    };
    this.sent.push({ target, text: content, options, result });
    return result;
  }

  get texts(): string[] {
    return this.sent.map((item) => item.text);
  }

  lastText(): string {
    return this.sent[this.sent.length - 1]?.text ?? '';
  }
}

export class FakeAgent implements AgentGateway {
  readonly submissions: AgentTaskRequest[] = [];

  readonly waited: string[] = [];

  readonly drafts: IssueDraft[] = [];

  error: Error | undefined;

  async submit(request: AgentTaskRequest): Promise<{ taskId: string }> {
    this.submissions.push(request);
    return { taskId: `task-${this.submissions.length}` };
  }

  async wait(taskId: string, _options?: WaitOptions): Promise<IssueDraft> {
    this.waited.push(taskId);
    if (this.error) {
      throw this.error;
    }
    const draft = this.drafts.shift();
    if (!draft) {
      throw new Error('FakeAgent 没有预置草稿');
    }
    return draft;
  }
}

export class FakeWriter implements IssueWriter {
  readonly requests: CreateIssueRequest[] = [];

  next: CreatedIssue = { number: 42, url: 'https://github.com/gregtech6ce/gregtech6/issues/42' };

  error: Error | undefined;

  async createIssue(request: CreateIssueRequest): Promise<CreatedIssue> {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return this.next;
  }
}

export function issueBinding(overrides: Partial<Binding> = {}): Binding {
  return {
    scope: `group:${GROUP}`,
    repo: 'gregtech6ce/gregtech6',
    maintainers: [MAINTAINER],
    allowedCommands: ['help', 'issue'],
    attachBotStop: true,
    ...overrides,
  };
}

export interface HarnessOptions {
  readonly binding?: Binding;
  readonly allowedCommands?: readonly CommandName[];
  readonly attachBotStop?: boolean;
  readonly withBinding?: boolean;
}

export interface Harness {
  readonly router: CommandRouter;
  readonly replier: RecordingReplier;
  readonly agent: FakeAgent;
  readonly writer: FakeWriter;
  readonly sessions: SessionStore;
  readonly binding: Binding;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const replier = new RecordingReplier();
  const agent = new FakeAgent();
  const writer = new FakeWriter();
  const sessions = new SessionStore();
  const binding = issueBinding({
    ...(options.allowedCommands ? { allowedCommands: [...options.allowedCommands] } : {}),
    ...(options.attachBotStop === undefined ? {} : { attachBotStop: options.attachBotStop }),
    ...options.binding,
  });
  const services: IssueServices = {
    agent,
    writer,
    pollIntervalMs: 1,
    taskTimeoutMs: 1_000,
  };
  const router = new CommandRouter({
    bindings: options.withBinding === false ? new Map() : new Map([[binding.scope, binding]]),
    replier,
    services,
    sessions,
    logger: createLogger({ sink: () => undefined }),
  });
  return { router, replier, agent, writer, sessions, binding };
}

export interface MessageInit {
  readonly id: string;
  readonly content: string;
  readonly senderId?: string;
  readonly senderIsBot?: boolean;
  readonly scopeKey?: string;
  readonly targetId?: string;
  readonly quotedRefIndex?: string;
}

export function message(init: MessageInit): InboundMessage {
  return {
    id: init.id,
    scope: 'group',
    scopeKey: init.scopeKey ?? `group:${GROUP}`,
    targetId: init.targetId ?? GROUP,
    senderId: init.senderId ?? MAINTAINER,
    senderIsBot: init.senderIsBot ?? false,
    content: init.content,
    timestamp: '2026-01-01T00:00:00Z',
    ...(init.quotedRefIndex ? { quotedRefIndex: init.quotedRefIndex } : {}),
    attachments: [],
    mentions: [],
  };
}
