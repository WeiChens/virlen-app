/**
 * 提示词契约一致性测试（与工具定义「机制 C」同一模式）
 *
 * **权威源**：`src-tauri/virlen-core/src/agent/prompts/*.md`
 *   - Rust 侧 `agent::prompts` 用 `include_str!` **就地**引用（不再 `../../../../../` 指向前端）
 *   - 前端：Tauri 走 `cmd_agent_prompts`；浏览器 dev / vitest 直读同一份 md
 *     （`infrastructure/prompts/prompt-source.ts`）
 *
 * 守三条线：
 *   1. 五个提示词齐备、非空，且关键标记（基础段标题 / 验证占位符）没丢；
 *   2. 适配器给出的内嵌文本 == 权威源文件本身（**不存在第二份副本**）；
 *   3. `promptText()` 的 fail-fast 语义：未水合时抛错，水合后同步可读。
 */
import { afterEach, describe, expect, it } from 'vitest'
import TOOL_CALL_SPEC from '../../../src-tauri/virlen-core/src/agent/prompts/tool-call-spec.md?raw'
import CORE_PRINCIPLES from '../../../src-tauri/virlen-core/src/agent/prompts/core-principles.md?raw'
import COMPRESS_CONTEXT from '../../../src-tauri/virlen-core/src/agent/prompts/compress-context.md?raw'
import GENERATE_TITLE from '../../../src-tauri/virlen-core/src/agent/prompts/generate-title.md?raw'
import VERIFY_PROMPT from '../../../src-tauri/virlen-core/src/agent/prompts/verify-prompt.md?raw'
import {
  hasPromptTexts,
  promptText,
  setPromptTexts,
  type PromptKey,
} from '@/domain/agent'
import {
  embeddedPromptTexts,
  loadPromptTexts,
} from '@/infrastructure/prompts/prompt-source'

/** 权威源（直接读 core 目录里的同一份文件） */
const SOURCE: Record<PromptKey, string> = {
  toolCallSpec: TOOL_CALL_SPEC,
  corePrinciples: CORE_PRINCIPLES,
  compressContext: COMPRESS_CONTEXT,
  generateTitle: GENERATE_TITLE,
  verifyPrompt: VERIFY_PROMPT,
}

const KEYS = Object.keys(SOURCE) as PromptKey[]

describe('提示词契约（权威源在 virlen-core）', () => {
  it('五个提示词齐备且非空', () => {
    expect(KEYS).toHaveLength(5)
    for (const key of KEYS) {
      expect(SOURCE[key].trim().length, `提示词 ${key} 为空`).toBeGreaterThan(20)
    }
  })

  it('关键标记没丢（基础段标题 / 验证占位符）', () => {
    expect(SOURCE.toolCallSpec).toContain('# Tool Call Specification')
    expect(SOURCE.corePrinciples).toContain('# Core Principles')
    expect(SOURCE.verifyPrompt).toContain('{{goal}}')
    expect(SOURCE.verifyPrompt).toContain('{{trace}}')
  })

  it('适配器给出的内嵌文本就是权威源本身（不存在第二份副本）', () => {
    expect(embeddedPromptTexts()).toEqual(SOURCE)
  })

  it('非 Tauri 环境下加载器回退到内嵌文本', async () => {
    await expect(loadPromptTexts()).resolves.toEqual(SOURCE)
  })
})

describe('promptText 的 fail-fast 语义', () => {
  // 每个用例后恢复 setup.ts 的水合，避免污染同文件内后续用例
  afterEach(() => {
    setPromptTexts(embeddedPromptTexts())
  })

  it('未水合时抛错，而不是静默返回空串', () => {
    setPromptTexts(null)
    expect(hasPromptTexts()).toBe(false)
    expect(() => promptText('toolCallSpec')).toThrow(/未水合/)
  })

  it('水合后同步可读', () => {
    setPromptTexts(SOURCE)
    expect(hasPromptTexts()).toBe(true)
    expect(promptText('corePrinciples')).toBe(CORE_PRINCIPLES)
    expect(promptText('verifyPrompt')).toBe(VERIFY_PROMPT)
  })
})
