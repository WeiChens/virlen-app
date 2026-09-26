/**
 * 提示词来源适配器（infrastructure）—— 把 Rust 侧的提示词交给 domain 层
 *
 * 两条路径读的是**同一份物理文件** `src-tauri/virlen-core/src/agent/prompts/*.md`：
 *
 * | 环境 | 取值方式 | 说明 |
 * |---|---|---|
 * | Tauri 运行时 | `cmd_agent_prompts` | Rust `include_str!` 已把文本嵌进二进制；权威且只有一份 |
 * | 浏览器 dev / vitest | 静态 `?raw` 导入 | 构建期从 core 目录读同一份文件 |
 *
 * 因为两条路径同源，这里不需要任何「差异检查」逻辑（与 `definitions-source.ts` 同一取舍）。
 *
 * ⚠️ 用**静态** import（`definitions-source.ts` 用的是**动态** import）：提示词要在启动阶段
 *    **同步水合**（`setPromptTexts`），且五个文件合计约 4 KB —— 不值得为它引入 async 分支。
 *    也因此，Tauri 构建里这段文本会在 JS 包里出现一份 —— 但它**就是**同一份文件构建期读出来的，
 *    与 Rust 二进制里那份不可能漂移。
 */
import { invoke } from '@tauri-apps/api/core'
import type { PromptTexts } from '@/domain/agent'
import TOOL_CALL_SPEC from '../../../src-tauri/virlen-core/src/agent/prompts/tool-call-spec.md?raw'
import CORE_PRINCIPLES from '../../../src-tauri/virlen-core/src/agent/prompts/core-principles.md?raw'
import COMPRESS_CONTEXT from '../../../src-tauri/virlen-core/src/agent/prompts/compress-context.md?raw'
import GENERATE_TITLE from '../../../src-tauri/virlen-core/src/agent/prompts/generate-title.md?raw'
import VERIFY_PROMPT from '../../../src-tauri/virlen-core/src/agent/prompts/verify-prompt.md?raw'

/** 是否在 Tauri 环境（与 `services/rust-engine.ts::isTauriAvailable` 同一判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 内嵌提示词（构建期从 core 目录读入）。
 *
 * 它既是**浏览器 dev / vitest** 的取值路径，也是 Tauri 下命令失败时的兜底 ——
 * 兜底给的仍是同一份文本，所以降级不会改变模型看到的内容。
 */
export function embeddedPromptTexts(): PromptTexts {
  return {
    toolCallSpec: TOOL_CALL_SPEC,
    corePrinciples: CORE_PRINCIPLES,
    compressContext: COMPRESS_CONTEXT,
    generateTitle: GENERATE_TITLE,
    verifyPrompt: VERIFY_PROMPT,
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
