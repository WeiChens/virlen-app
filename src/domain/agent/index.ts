/**
 * 提示词文本的 domain 层入口（barrel）。
 *
 * 文本本体在 Rust `prompts/*.md`：Tauri 经 `cmd_agent_prompts` 取，浏览器 dev / vitest 直读同一份 md（`?raw`）。
 * 消费方统一从 `@/domain/agent` 取，无需关心来源接线。
 */
export { hasPromptTexts, promptText, setPromptTexts } from './prompt-texts'
export type { PromptKey, PromptTexts } from './prompt-texts'
