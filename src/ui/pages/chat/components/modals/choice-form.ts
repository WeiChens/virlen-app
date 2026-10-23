/**
 * useChoiceForm — `user_choice` 的表单状态（勾选 / 自定义回复 / 草稿上报）。
 *
 * 弹窗（`modals/user-choice`）与「会话内卡片」（`inline-interactions`）共用这一份：两套壳只差外框与键盘口径。
 * ⚠️ 这里**不做键盘、不做提交**：弹窗在 backdrop 上接管 document 级 Enter / Esc，行内卡片只认自己输入框里
 * 的那一下 Enter —— 混进来就会两边打架（一次回车提交两遍）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChoiceDraft } from './choice-drafts'

export interface ChoiceForm {
  /** 选项（AI 漏传时的空数组兜底已在这里做掉） */
  options: string[]
  multi: boolean
  selected: Set<string>
  toggle: (option: string) => void
  /** 按选项下标切换（弹窗键盘导航用；越界忽略） */
  toggleAt: (index: number) => void
  showCustom: boolean
  /** 展开 / 收起自定义输入框（聚焦由壳负责：它才持有 input ref） */
  toggleCustom: () => void
  customReply: string
  setCustomReply: (value: string) => void
  /** 有勾选或有自定义回复才允许提交 */
  canConfirm: boolean
  /** 提交给工具层的结构化值 */
  value: { selected: string[]; customReply: string }
}

export function useChoiceForm({
  options,
  multi,
  initialDraft,
  onDraftChange,
}: {
  options: string[]
  multi: boolean
  /** 预填草稿（暂存 → 恢复：同一个 toolCallId 上一次填的内容）—— **只在挂载时**取，之后不再覆盖用户输入 */
  initialDraft?: ChoiceDraft
  /** 每次改动都上报（外部按 `sessionId|toolCallId` 缓存，见 `choice-drafts.ts`） */
  onDraftChange?: (draft: ChoiceDraft) => void
}): ChoiceForm {
  const safeOptions = Array.isArray(options) ? options : []
  // 初始值取草稿：暂存 → 恢复（新 interactionId、新实例、同一个 toolCallId）时把上次填的带回来
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialDraft?.selected ?? []),
  )
  const [showCustom, setShowCustom] = useState(!!initialDraft?.showCustom)
  const [customReply, setCustomReply] = useState(initialDraft?.customReply ?? '')

  // 每次改动都上报草稿。
  // ⚠️ 回调用 ref 持有：它每次渲染都是新引用，进依赖会让这个 effect 退化成「每次渲染都上报」。
  const draftChangeRef = useRef(onDraftChange)
  draftChangeRef.current = onDraftChange
  useEffect(() => {
    draftChangeRef.current?.({
      selected: [...selected],
      customReply,
      showCustom,
    })
  }, [selected, customReply, showCustom])

  function toggle(option: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(option)) {
        next.delete(option)
      } else {
        if (!multi) next.clear()
        next.add(option)
      }
      return next
    })
  }

  return {
    options: safeOptions,
    multi,
    selected,
    toggle,
    toggleAt: (index: number) => {
      const option = safeOptions[index]
      if (option === undefined) return
      toggle(option)
    },
    showCustom,
    toggleCustom: () => setShowCustom((v) => !v),
    customReply,
    setCustomReply,
    canConfirm: selected.size > 0 || customReply.trim().length > 0,
    value: { selected: [...selected], customReply: customReply.trim() },
  }
}
