/**
 * 提示词文本的**前端侧快照**（纯模块，零 I/O）
 *
 * 文本本体在 Rust —— `src-tauri/virlen-core/src/agent/prompts/*.md`。前端**不再自带副本**：
 * 组合根（`src/main.ts`）启动时经 `loadPromptTexts()` 水合一次，此后所有消费者**同步**读取。
 *
 * 为什么是「启动水合 + 同步读」而不是「每次异步去取」：
 * `baseSystemPrompt()` 是**同步**函数（`composeSystemPrompt`、golden 测试都直接调它），
 * 改成 async 会把它传染给整条组装链和所有调用方 —— 代价远大于「启动时等一次 IPC」。
 *
 * 接线与工具定义（机制 C）同构：`src/main.ts` 接真实加载器、`src/tests/setup.ts` 接内嵌文本。
 */

/** 提示词的键 —— 与 Rust `prompts::PromptTexts` 的 camelCase 字段一一对应 */
export type PromptKey =
  | 'toolCallSpec'
  | 'corePrinciples'
  | 'compressContext'
  | 'generateTitle'
  | 'verifyPrompt'

/** 全量提示词文本 */
export type PromptTexts = Record<PromptKey, string>

let snapshot: PromptTexts | null = null

/**
 * 注入提示词快照。
 *
 * 传 `null` 清除（测试之间需要隔离时用；与 `setToolDefinitionsLoader(null)` 同义）。
 */
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
 * ⚠️ 未水合时抛错而不是返回空串：空提示词会静默改变模型行为（丢掉工具规范 / 验证要求，
 * 模型照样能跑、只是变笨），而「启动少接了一步线」应当立刻炸出来。取舍与 `toolRegistry`
 * 的「加载器未注入」一致。
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
