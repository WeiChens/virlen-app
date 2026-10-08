/**
 * choice-drafts — `user_choice` 弹窗的**草稿缓存**：暂存（shelve）后不丢，恢复时带回来。
 *
 * 为什么需要它：用户点「暂存」→ 这次交互被出队，引擎把 run 存成暂停快照（Rust `RunSnapshot`
 * 带 `tool_call_id`）；用户之后点「继续」，引擎从快照恢复、**重新执行同一个 tool call**（同一个
 * toolCallId）→ 会再弹一次同一个问题。但那是**新的 interactionId + 新的弹窗实例** —— 表单里的勾选 /
 * 自定义输入如果没有外部存储，就随第一个实例一起没了，用户得从头再填一遍。
 *
 * 存储键用 `sessionId|toolCallId`：暂存 ↔ 恢复之间 toolCallId 稳定（快照里存的就是它），
 * 而 interactionId 每次都换（不能拿它当键）。
 *
 * 生命周期：
 *  - **暂存（shelve）→ 保留**（之后还会再问一次，草稿要带回去）；
 *  - 应答（allow）/ 取消（reject）/ 运行结束收敛（expired）→ 清掉（这些路径之后不会再问同一个问题）。
 */
export interface ChoiceDraft {
  /** 已勾选的选项文本 */
  selected: string[]
  /** 自定义补充回复 */
  customReply: string
  /** 自定义输入框是否处于展开状态（用户展开了就该保持展开，否则「草稿还在」但看不见） */
  showCustom: boolean
}

const drafts = new Map<string, ChoiceDraft>()

/**
 * 草稿键。`toolCallId` 为空（异常载荷）时返回空串 —— 调用方据此跳过缓存（草稿能力降级，不影响应答）。
 */
export function draftKey(sessionId: string, toolCallId: string): string {
  if (!toolCallId) return ''
  return `${sessionId}|${toolCallId}`
}

/** 存草稿（用户每次改动都写）。空键 = 不缓存。 */
export function saveChoiceDraft(key: string, draft: ChoiceDraft): void {
  if (!key) return
  drafts.set(key, draft)
}

/**
 * 取草稿（新弹窗挂载时预填）。
 * ⚠️ 取用**不删除**：恢复后的弹窗如果又被暂存，草稿得再带回来一次。
 */
export function getChoiceDraft(key: string): ChoiceDraft | undefined {
  if (!key) return undefined
  return drafts.get(key)
}

/** 清草稿（应答 / 取消 / 收敛时调用；幂等，未知键原样无操作） */
export function clearChoiceDraft(key: string): void {
  if (!key) return
  drafts.delete(key)
}

/** 仅供测试：模块级单例，用例之间必须隔离 */
export function clearAllChoiceDrafts(): void {
  drafts.clear()
}
