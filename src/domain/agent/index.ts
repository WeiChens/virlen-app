/**
 * 提示词文本的 domain 层入口（barrel）
 *
 * 文本本体在 Rust（`src-tauri/virlen-core/src/agent/prompts/*.md`）：
 * - **Tauri 运行时**：经命令 `cmd_agent_prompts` 取（见 `infrastructure/prompts/prompt-source.ts`）
 * - **浏览器 dev / vitest**：直读 core 目录里**同一份** md（`?raw`）
 *
 * 消费方统一从 `@/domain/agent` 取，不需要知道来源是怎么接的线。
 */
export { hasPromptTexts, promptText, setPromptTexts } from './prompt-texts'
export type { PromptKey, PromptTexts } from './prompt-texts'
