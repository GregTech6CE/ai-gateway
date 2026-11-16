import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { createLogger } from '@gt6ce/shared';
import { describe, expect, it } from 'vitest';

import { GatewaySendError } from '../src/errors.ts';
import {
  QQBotGateway,
  isFatalCloseCode,
  normalizeInboundMessage,
} from '../src/gateway.ts';
import type {
  GatewayConfig,
  Transport,
  TransportHandlers,
  TransportSendRequest,
  TransportSendResult,
} from '../src/types.ts';

const CONFIG: GatewayConfig = {
  appId: 'app-1',
  appSecret: 'secret-1',
  sandbox: false,
  markdownSupport: true,
};

class FakeTransport implements Transport {
  readonly sent: TransportSendRequest[] = [];

  /** 按调用顺序消费：`null` 表示成功，数字表示抛出的业务码。 */
  readonly script: Array<number | null> = [];

  handlers: TransportHandlers | undefined;

  stopped = false;

  flushed = false;

  startError: unknown;

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  flush(): void {
    this.flushed = true;
  }

  async send(request: TransportSendRequest): Promise<TransportSendResult> {
    this.sent.push(request);
    const code = this.script.shift() ?? null;
    if (code !== null) {
      throw Object.assign(new Error(`platform rejected ${code}`), { bizCode: code, httpStatus: 400 });
    }
    return { messageId: `m-${this.sent.length}`, refIndex: `r-${this.sent.length}` };
  }
}

function loggerLines(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    scope: 'test',
    sink: (line) => lines.push(line),
    now: () => new Date(0),
  });
  return { logger, lines };
}

describe('isFatalCloseCode', () => {
  it('覆盖凭据/权限/分片类关闭码', () => {
    for (const code of [4001, 4002, 4010, 4011, 4012, 4013, 4014]) {
      expect(isFatalCloseCode(code)).toBe(true);
    }
    for (const code of [1000, 4009, 4914]) {
      expect(isFatalCloseCode(code)).toBe(false);
    }
  });
});

describe('QQBotGateway.reply', () => {
  it('单条回复按 Markdown 发送，msg_seq 从 1 开始', async () => {
    const transport = new FakeTransport();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger: loggerLines().logger });

    const result = await gateway.reply(
      { scope: 'group', targetId: 'group-1', msgId: 'in-1' },
      '## 结论\n\n正常',
    );

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      scope: 'group',
      targetId: 'group-1',
      msgId: 'in-1',
      msgSeq: 1,
      markdown: '## 结论\n\n正常',
      text: null,
    });
    expect(result).toEqual({
      messageIds: ['m-1'],
      refIndexes: ['r-1'],
      chunks: 1,
      degraded: false,
    });
  });

  it('多片回复共享同一 msg_id 的单调序号', async () => {
    const transport = new FakeTransport();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger: loggerLines().logger });
    const content = Array.from({ length: 200 }, (_, index) => `第 ${index} 行：${'内容'.repeat(20)}`).join('\n');

    const result = await gateway.reply({ scope: 'group', targetId: 'g', msgId: 'in-2' }, content);

    expect(result.chunks).toBeGreaterThan(1);
    expect(transport.sent.map((item) => item.msgSeq)).toEqual(
      Array.from({ length: result.chunks }, (_, index) => index + 1),
    );
    expect(result.messageIds).toHaveLength(result.chunks);
  });

  it('主动推送（无 msgId）不传 msg_seq，交给平台默认值', async () => {
    const transport = new FakeTransport();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger: loggerLines().logger });

    await gateway.reply({ scope: 'c2c', targetId: 'user-1' }, '你好');

    expect(transport.sent[0]?.msgId).toBeUndefined();
    expect(transport.sent[0]?.msgSeq).toBeUndefined();
  });

  it('Markdown 无权限时降级为纯文本，并对同一条消息只重发一次', async () => {
    const transport = new FakeTransport();
    transport.script.push(304036);
    const { logger, lines } = loggerLines();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger });
    const content = Array.from({ length: 120 }, (_, index) => `第 ${index} 行：${'内容'.repeat(20)}`).join('\n');

    const result = await gateway.reply({ scope: 'group', targetId: 'g', msgId: 'in-3' }, content);

    expect(result.degraded).toBe(true);
    expect(transport.sent.length).toBe(result.chunks + 1);
    // 第一次以 Markdown 发出并被拒绝。
    expect(transport.sent[0]?.text).toBeNull();
    expect(transport.sent[0]?.markdown).not.toBeNull();
    // 重发与后续分片全部走纯文本，且序号继续单调递增。
    for (const request of transport.sent.slice(1)) {
      expect(request.markdown).toBeNull();
      expect(request.text).not.toBeNull();
    }
    expect(transport.sent.map((item) => item.msgSeq)).toEqual(
      Array.from({ length: transport.sent.length }, (_, index) => index + 1),
    );
    expect(lines.some((line) => line.includes('304036'))).toBe(true);
  });

  it('非 Markdown 权限错误不降级，抛 GatewaySendError 并记录业务码', async () => {
    const transport = new FakeTransport();
    transport.script.push(40034128);
    const { logger, lines } = loggerLines();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger });

    const failure = gateway.reply({ scope: 'group', targetId: 'g', msgId: 'in-4' }, '正文');
    await expect(failure).rejects.toBeInstanceOf(GatewaySendError);
    await expect(failure).rejects.toMatchObject({ code: 40034128, httpStatus: 400 });
    expect(lines.some((line) => line.includes('40034128') && line.includes('in-4'))).toBe(true);
    expect(transport.sent).toHaveLength(1);
  });

  it('markdownSupport=false 时直接发纯文本', async () => {
    const transport = new FakeTransport();
    const gateway = new QQBotGateway({
      config: { ...CONFIG, markdownSupport: false },
      transport,
      logger: loggerLines().logger,
    });

    const result = await gateway.reply({ scope: 'group', targetId: 'g', msgId: 'in-6' }, '**粗体**');

    expect(transport.sent[0]).toMatchObject({ markdown: null, text: '**粗体**' });
    expect(result.degraded).toBe(false);
  });
});

describe('QQBotGateway 关闭码处理', () => {
  it('不可恢复关闭码触发停机回调并停止传输层', async () => {
    const transport = new FakeTransport();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger: loggerLines().logger });
    const fatal: Array<{ code: number; reason: string }> = [];
    gateway.onFatal((event) => fatal.push(event));

    await gateway.start();
    transport.handlers?.onDisconnected({ code: 4014, reason: 'invalid intent', willReconnect: false });

    expect(fatal).toEqual([{ code: 4014, reason: 'invalid intent' }]);
    expect(transport.stopped).toBe(true);
  });

  it('可恢复关闭码不触发停机，只记录日志', async () => {
    const transport = new FakeTransport();
    const { logger, lines } = loggerLines();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger });
    let fatalCount = 0;
    gateway.onFatal(() => {
      fatalCount += 1;
    });

    await gateway.start();
    transport.handlers?.onDisconnected({ code: 4009, reason: 'session timed out', willReconnect: true });

    expect(fatalCount).toBe(0);
    expect(transport.stopped).toBe(false);
    expect(lines.some((line) => line.includes('4009'))).toBe(true);
  });

  it('start() 因不可恢复原因 reject 时同样上报 fatal', async () => {
    const transport = new FakeTransport();
    transport.startError = Object.assign(new Error('fatal close'), {
      name: 'GatewayError',
      closeCode: 4013,
    });
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger: loggerLines().logger });
    const fatal: Array<{ code: number; reason: string }> = [];
    gateway.onFatal((event) => fatal.push(event));

    await gateway.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fatal).toEqual([{ code: 4013, reason: 'fatal close' }]);
  });
});

describe('QQBotGateway 生命周期', () => {
  it('stop 停止传输层、落盘并清理序号', async () => {
    const transport = new FakeTransport();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger: loggerLines().logger });
    await gateway.start();
    await gateway.reply({ scope: 'group', targetId: 'g', msgId: 'in-7' }, 'x');

    await gateway.stop();

    expect(transport.stopped).toBe(true);
    expect(transport.flushed).toBe(true);
    // 再次 stop 是幂等的。
    await gateway.stop();
  });

  it('消息处理器抛错时不影响其他处理器', async () => {
    const transport = new FakeTransport();
    const { logger, lines } = loggerLines();
    const gateway = new QQBotGateway({ config: CONFIG, transport, logger });
    const seen: string[] = [];
    gateway.onMessage(() => {
      throw new Error('boom');
    });
    gateway.onMessage((message) => {
      seen.push(message.id);
    });
    const errors: Error[] = [];
    gateway.onError((error) => errors.push(error));

    await gateway.start();
    await transport.handlers?.onMessage({
      id: 'in-8',
      scope: 'group',
      scopeKey: 'group:g',
      targetId: 'g',
      senderId: 'u1',
      senderIsBot: false,
      content: 'hi',
      timestamp: '0',
      attachments: [],
      mentions: [],
    });

    expect(seen).toEqual(['in-8']);
    expect(errors.map((error) => error.message)).toEqual(['boom']);
    expect(lines.some((line) => line.includes('消息处理器抛错'))).toBe(true);
  });
});

describe('normalizeInboundMessage', () => {
  const base = {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'user-openid',
    senderName: '张三',
    content: ' /issue 崩溃',
    messageId: 'msg-1',
    timestamp: '2026-01-01T00:00:00Z',
    groupOpenid: 'group-openid',
    refMsgIdx: 'ref-9',
    attachments: [{ content_type: 'image/png', url: 'https://example.test/a.png', filename: 'a.png', size: 12 }],
    mentions: [{ user_openid: 'bot-openid', nickname: '机器人', bot: true, is_you: true }],
    raw: {},
  } as unknown as QQBotInboundMessage;

  it('群消息映射为规范化会话键，并保留引用序号', () => {
    expect(normalizeInboundMessage(base)).toEqual({
      id: 'msg-1',
      scope: 'group',
      scopeKey: 'group:group-openid',
      targetId: 'group-openid',
      senderId: 'user-openid',
      senderIsBot: false,
      senderName: '张三',
      content: ' /issue 崩溃',
      timestamp: '2026-01-01T00:00:00Z',
      quotedRefIndex: 'ref-9',
      attachments: [{ contentType: 'image/png', url: 'https://example.test/a.png', filename: 'a.png', size: 12 }],
      mentions: [{ userId: 'bot-openid', name: '机器人', isBot: true, isSelf: true }],
    });
  });

  it('频道与频道私信不在首版范围，返回 undefined', () => {
    expect(normalizeInboundMessage({ ...base, kind: 'guild' } as unknown as QQBotInboundMessage)).toBeUndefined();
  });

  it('群 openid 缺失时返回 undefined', () => {
    expect(
      normalizeInboundMessage({ ...base, groupOpenid: undefined } as unknown as QQBotInboundMessage),
    ).toBeUndefined();
  });
});
