/**
 * 提示词文本的前端侧快照（零 I/O）。文本本体在 Rust `prompts/*.md`，启动时经
 * `loadPromptTexts()` 水合一次，此后同步读取。
 *
 * 之所以「启动水合 + 同步读」而非每次异步取：`baseSystemPrompt()` 是同步函数（组装链与 golden 测试
 * 直接调），改 async 会传染整条链，代价远大于启动时等一次 IPC。
 */

/** 提示词的键 —— 与 Rust `prompts::PromptTexts` 的 camelCase 字段一一对应 */
export type PromptKey =
  | 'toolCallSpec'
  | 'corePrinciples'
  | 'compressContext'
  | 'generateTitle'
  | 'verifyPrompt'
  | 'memoryDistill'

/** 全量提示词文本 */
export type PromptTexts = Record<PromptKey, string>

let snapshot: PromptTexts | null = null

/** 注入提示词快照；传 `null` 清除（测试隔离用）。 */
export function setPromptTexts(texts: PromptTexts | null): void {
  snapshot = texts
}

/** 快照是否已水合 */
export function hasPromptTexts(): boolean {
  return snapshot !== null
}

/**
 * 读取一条提示词（同步）。
 *
 * ⚠️ 未水合时抛错而非返回空串：空提示词会静默改变模型行为（模型照样能跑、只是变笨）。
 */
export function promptText(key: PromptKey): string {
  if (!snapshot) {
    throw new Error(
      '提示词未水合：启动时请调用 setPromptTexts(await loadPromptTexts())（见 src/main.ts）',
    )
  }
  const text = snapshot[key]
  if (!text) {
    throw new Error(
      `提示词 \`${key}\` 为空或缺失（权威源：src-tauri/virlen-core/src/agent/prompts/）`,
    )
  }
  return text
}
