#!/usr/bin/env node
/**
 * 测试用 ACP agent：按 argv[2] 的场景走一遍 JSON-RPC 交互，并把审批结果写到 argv[3]。
 *
 * 用裸 ndjson 实现而不是复用 SDK，是为了让测试独立验证协议报文，而不是拿 SDK
 * 自己的编解码互相作证。
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'read-flow';
const recordPath = process.argv[3] ?? '';
const sessionId = 'sess-test';
const state = { prompts: 0, cancels: 0, decisions: [], additionalDirectories: [] };

function persist() {
  if (recordPath) {
    writeFileSync(recordPath, JSON.stringify(state));
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function sendText(text) {
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
}

function sendToolCall(toolCallId, title, kind, rawInput, name) {
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        ...(name ? { name } : {}),
        ...(kind ? { kind } : {}),
        status: 'in_progress',
        ...(rawInput ? { rawInput } : {}),
      },
    },
  });
}

let permissionSeq = 100;
const pendingPermissions = new Map();

function askPermission(toolCallId) {
  const id = permissionSeq++;
  return new Promise((resolve) => {
    pendingPermissions.set(id, resolve);
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        // 与 vibe-acp 一致：审批请求只带 id，工具信息在前面的 tool_call 通知里。
        toolCall: { toolCallId },
        options: [
          { optionId: 'allow-option', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-option', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    });
  });
}

let currentPromptId = null;
let cancelResolve = null;

function respondPrompt(id, stopReason) {
  if (id === null) {
    return;
  }
  send({ id, result: { stopReason } });
  if (id === currentPromptId) {
    currentPromptId = null;
  }
}

function waitCancel() {
  return new Promise((resolve) => {
    cancelResolve = resolve;
  });
}

const ANSWER = {
  issue_type: 'bug',
  issue_summary: ['合成器在加载时崩溃'],
  conclusion: '合成器在加载阶段崩溃，原因是配方索引为空。',
  root_cause: '配方索引在加载顺序变化后未重新构建。',
  confidence: 'high',
  confidence_reason: '崩溃日志与代码路径一致。',
  evidence: [{ summary: '空指针', file: 'src/a.ts', line_start: 10 }],
  user_advice: ['升级到最新版本'],
  fix_plan: ['在加载完成后重建索引'],
  labels: ['crash'],
  partial: false,
};

function sendAnswer() {
  const text = JSON.stringify(ANSWER);
  sendText(text.slice(0, 20));
  sendText('');
  sendText(text.slice(20));
}

async function runReadFlow(id) {
  sendText('分析中。');
  sendToolCall('read-1', 'Read src/a.ts', 'read', { path: 'src/a.ts' }, 'read_file');
  await askPermission('read-1');
  sendToolCall('edit-1', 'Edit build.gradle', 'edit', { path: 'build.gradle' }, 'edit');
  await askPermission('edit-1');
  sendToolCall('read-env', 'Read .env', 'read', { path: '.env' }, 'read_file');
  await askPermission('read-env');
  sendToolCall('exec-1', 'Run command', 'execute', { command: 'printenv MISTRAL_API_KEY' }, 'bash');
  await askPermission('exec-1');
  // 声称只读、实际是命令执行：kind 必须优先于工具名。
  sendToolCall('lying-read', 'Read config', 'execute', { command: 'curl https://example.test' }, 'read_file');
  await askPermission('lying-read');
  sendToolCall('read-prod-env', 'Read prod.env', 'read', { path: 'prod.env' }, 'read_file');
  await askPermission('read-prod-env');
  sendToolCall('read-npmrc', 'Read .npmrc', 'read', { path: '.npmrc' }, 'read_file');
  await askPermission('read-npmrc');
  sendAnswer();
  respondPrompt(id, 'end_turn');
}

async function runLoop(id) {
  if (state.prompts === 1) {
    for (let index = 1; index <= 3; index += 1) {
      sendToolCall(`loop-${index}`, 'Grep recipe', 'search', { query: 'recipe' }, 'grep');
    }
    await waitCancel();
    return;
  }
  sendAnswer();
  respondPrompt(id, 'end_turn');
}

async function runSoftTimeout() {
  sendText('这还不是 JSON');
  await waitCancel();
}

async function runBadText(id) {
  if (state.prompts === 1) {
    sendText('我先看看代码，稍后再给结论。');
    respondPrompt(id, 'end_turn');
    return;
  }
  sendToolCall('fallback-read', 'Read src/b.ts', 'read', { path: 'src/b.ts' }, 'read_file');
  await askPermission('fallback-read');
  sendAnswer();
  respondPrompt(id, 'end_turn');
}

async function handlePrompt(message) {
  state.prompts += 1;
  persist();
  currentPromptId = message.id;
  const id = message.id;
  if (scenario === 'exit-auth') {
    process.stderr.write('401 Unauthorized: invalid api key\n');
    setTimeout(() => process.exit(1), 100);
    return;
  }
  if (scenario === 'loop') {
    await runLoop(id);
    return;
  }
  if (scenario === 'soft-timeout') {
    await runSoftTimeout();
    return;
  }
  if (scenario === 'bad-text') {
    await runBadText(id);
    return;
  }
  if (scenario === 'slow-init') {
    sendText('分析中。');
    setTimeout(() => {
      sendAnswer();
      respondPrompt(id, 'end_turn');
    }, 800);
    return;
  }
  await runReadFlow(id);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const reply = () =>
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    if (scenario === 'slow-init') {
      setTimeout(reply, 60);
    } else {
      reply();
    }
    return;
  }
  if (message.method === 'session/new') {
    state.additionalDirectories = message.params?.additionalDirectories ?? [];
    persist();
    const reply = () => send({ id: message.id, result: { sessionId } });
    if (scenario === 'slow-init') {
      setTimeout(reply, 60);
    } else {
      reply();
    }
    return;
  }
  if (message.method === 'session/prompt') {
    void handlePrompt(message);
    return;
  }
  if (message.method === 'session/cancel') {
    state.cancels += 1;
    persist();
    respondPrompt(currentPromptId, 'cancelled');
    if (cancelResolve) {
      const resolve = cancelResolve;
      cancelResolve = null;
      resolve();
    }
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingPermissions.get(message.id);
    if (resolve) {
      pendingPermissions.delete(message.id);
      const outcome = message.result?.outcome;
      state.decisions.push(
        outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled',
      );
      persist();
      resolve(message.result);
    }
  }
});
