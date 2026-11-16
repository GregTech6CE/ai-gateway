/**
 * 提示词装配。
 *
 * 风格与规则写在 `prompts/` 的 Markdown 里（运维可改，不需要重新构建镜像）；
 * 仓库级的事实（仓库名、允许标签）从 `repos.json` 生成，避免提示词与配置漂移。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedRepoConfig } from '@gt6ce/shared';
import { ConfigError } from '@gt6ce/shared';

import type { AgentTaskRequest } from './contracts.ts';

const PROFILE_PATTERN = /^[a-z0-9_-]+$/;

/** 读 `repos/<profile>/draft.md`，不存在则回落 `common/draft.md`；两者都缺即配置错误。 */
export function loadDraftPrompt(promptsDir: string, profile: string | undefined): string {
  const candidates: string[] = [];
  if (profile !== undefined && PROFILE_PATTERN.test(profile)) {
    candidates.push(join(promptsDir, 'repos', profile, 'draft.md'));
  }
  candidates.push(join(promptsDir, 'common', 'draft.md'));
  for (const path of candidates) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (text !== '') {
        return text;
      }
    }
  }
  throw new ConfigError(promptsDir, ['缺少 common/draft.md']);
}

/** 允许模型使用的标签集合：优先六轴，没有轴配置时用 `write_only`。 */
export function allowedLabels(repo: ResolvedRepoConfig): string[] {
  const axes = repo.triage.label_axes;
  const values = Object.values(axes).flatMap((items) => items ?? []);
  const source = values.length > 0 ? values : repo.triage.write_only;
  return [...new Set(source.map((item) => item.trim()).filter((item) => item !== ''))];
}

/** system = Markdown 规则 + 本次仓库的事实约束。 */
export function buildSystemPrompt(base: string, repo: ResolvedRepoConfig): string {
  const labels = allowedLabels(repo);
  return [
    base.trim(),
    '',
    '## 本次仓库约束',
    `- issue 仓库：${repo.key}`,
    `- 代码仓库：${repo.code_repo}`,
    `- 可用标签（只能从中选择，不要发明新标签）：${labels.length > 0 ? labels.join('、') : '（无）'}`,
    '- 正文使用简体中文 Markdown；保留用户给出的版本号与步骤，不要补写未提供的事实。',
    '- 不要写入任何 token、密钥、Cookie、内网地址或本地绝对路径。',
  ].join('\n');
}

/** user = 群会话收集到的原始字段，保持原样交给模型整理。 */
export function buildUserPrompt(request: AgentTaskRequest): string {
  const { draft } = request;
  const lines = [
    '请把下面的群聊反馈整理成一条可直接提交的 GitHub Issue。',
    '',
    `- 用户给出的标题：${draft.title}`,
    `- 版本：${draft.version}`,
    `- 复现步骤：${draft.steps}`,
    `- 期望结果：${draft.expected}`,
  ];
  if (draft.actual !== undefined) {
    lines.push(`- 实际表现：${draft.actual}`);
  }
  lines.push('', '要求：标题不超过 80 字；正文按「现象 / 复现步骤 / 期望结果 / 环境」组织；标签从可用标签中选择。');
  return lines.join('\n');
}
