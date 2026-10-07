/**
 * 提示词来源适配器（infrastructure）—— 把 Rust 侧的提示词交给 domain 层。
 *
 * 两条路径读**同一份物理文件** src-tauri/virlen-core/src/agent/prompts/*.md：Tauri 运行时走
 * cmd_agent_prompts（Rust include_str! 已把文本嵌进二进制，权威且只有一份）；浏览器 dev / vitest 走静态 ?raw 导入。
 * 两路径同源，故无需「差异检查」。用静态 import（提示词启动阶段同步水合，六个文件共约 6 KB）；Tauri 构建里 JS 包
 * 会多一份同样的文本，但它就是同一份文件构建期读出来的，不会漂移。
 */
import { invoke } from '@tauri-apps/api/core'
import type { PromptTexts } from '@/domain/agent'
import TOOL_CALL_SPEC from '../../../src-tauri/virlen-core/src/agent/prompts/tool-call-spec.md?raw'
import CORE_PRINCIPLES from '../../../src-tauri/virlen-core/src/agent/prompts/core-principles.md?raw'
import COMPRESS_CONTEXT from '../../../src-tauri/virlen-core/src/agent/prompts/compress-context.md?raw'
import GENERATE_TITLE from '../../../src-tauri/virlen-core/src/agent/prompts/generate-title.md?raw'
import VERIFY_PROMPT from '../../../src-tauri/virlen-core/src/agent/prompts/verify-prompt.md?raw'
import MEMORY_DISTILL from '../../../src-tauri/virlen-core/src/agent/prompts/memory-distill.md?raw'

/** 是否在 Tauri 环境（与 `services/rust-engine.ts::isTauriAvailable` 同一判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 内嵌提示词（构建期从 core 读入）：浏览器 dev / vitest 的取值路径，也是 Tauri 命令失败时的兜底（同一份文本）。 */
export function embeddedPromptTexts(): PromptTexts {
  return {
    toolCallSpec: TOOL_CALL_SPEC,
    corePrinciples: CORE_PRINCIPLES,
    compressContext: COMPRESS_CONTEXT,
    generateTitle: GENERATE_TITLE,
    verifyPrompt: VERIFY_PROMPT,
    memoryDistill: MEMORY_DISTILL,
  }
}

/** 默认加载器：Tauri 优先命令，失败 / 非 Tauri 环境走内嵌文本 */
export async function loadPromptTexts(): Promise<PromptTexts> {
  if (isTauriEnv()) {
    try {
      return await invoke<PromptTexts>('cmd_agent_prompts')
    } catch (e: any) {
      console.warn(
        `[prompts] cmd_agent_prompts 失败，降级到内嵌文本（同一份 md）：${e?.message || String(e)}`,
      )
    }
  }
  return embeddedPromptTexts()
}
