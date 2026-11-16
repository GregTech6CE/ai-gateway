/**
 * `/help`：只读命令，任何绑定了仓库的会话都能用。
 *
 * 展示内容来自注册表，而不是写死的文案：新增命令后无需改这里。
 */
import type { CommandContext, CommandRegistration, HandlerOutcome } from './types.ts';

async function handleHelp(context: CommandContext): Promise<HandlerOutcome> {
  const lines: string[] = ['**可用命令**', ''];
  for (const command of context.availableCommands) {
    lines.push(`${command.usage} — ${command.summary}`);
  }
  lines.push('', `**当前绑定的仓库**：\`${context.binding.repo}\``);

  const hasIssue = context.availableCommands.some((command) => command.name === 'issue');
  if (hasIssue) {
    lines.push(
      '',
      '**示例**',
      '/issue 合成器在 1.21.1 加载配方时崩溃',
      '',
      '**补充信息**',
      '发送 /issue 后，引用我的提问消息回复，即可逐条补充版本、复现步骤与期望结果。',
      '也可以直接用「标题：」「版本：」「复现：」「期望：」「实际：」开头的消息覆盖对应字段。',
    );
  } else {
    lines.push('', '本会话暂未启用写操作命令。');
  }

  await context.reply(lines.join('\n'), { markdown: true });
  return { handled: true };
}

export const HELP_COMMAND: CommandRegistration = {
  name: 'help',
  requiresMaintainer: false,
  summary: '查看可用命令与示例',
  usage: '/help',
  handler: handleHelp,
};
