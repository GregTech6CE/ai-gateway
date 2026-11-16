/**
 * 提示词加载：`prompts/common/<kind>.md` + 仓库 overlay。
 *
 * overlay 追加在 common 之后并显式声明「优先于 common」，与旧版 `prompt_text` 一致。
 * profile 名先做白名单校验再拼路径，避免配置里的值变成路径穿越。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PromptKind = 'analyze' | 'relevance' | 'nodes';

export interface PromptSource {
  readonly dir: string;
  readonly profile?: string;
}

const PROFILE_PATTERN = /^[a-z0-9_-]+$/;

export function loadPrompt(source: PromptSource, kind: PromptKind): string {
  const base = readFileSync(join(source.dir, 'common', `${kind}.md`), 'utf8').trimEnd();
  const profile = (source.profile ?? '').trim().toLowerCase();
  if (!profile) {
    return base;
  }
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error(`非法的 prompt profile: ${profile}`);
  }
  const overlayPath = join(source.dir, 'repos', profile, `${kind}.md`);
  if (!existsSync(overlayPath)) {
    return base;
  }
  const overlay = readFileSync(overlayPath, 'utf8').trim();
  return `${base}\n\n## 仓库特定规则（优先于 common）\n\n${overlay}\n`;
}

/** 分析用 system 提示词：分析规则 + 工具使用方式 + 仓库 overlay。 */
export function buildAnalysisSystem(source: PromptSource): string {
  const analyze = loadPrompt(source, 'analyze');
  const nodes = loadPrompt(source, 'nodes');
  return `${analyze}\n\n${nodes}\n`;
}
