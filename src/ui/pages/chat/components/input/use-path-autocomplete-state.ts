/**
 * 路径自动补全状态 — 工作区解析 + 补全下拉 + 选中索引
 *
 * 工作区来源（与 chat-view 的 WorkspaceDisplay 保持一致）：
 *   有会话 → 会话的 workspace；无会话 → chatState.selectedWorkspace；再回退 defaultWorkspace。
 */
import { useEffect, useState } from 'react'
import {
  chatState,
  resolveDefaultWorkspace,
  sessionStore,
  settingsState,
} from '@/ui/store'
import { usePathAutocomplete } from './path-autocomplete'

export function usePathAutocompleteState(
  value: string,
  cursorPos: number,
  sessionId?: string,
) {
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [autoSelectIdx, setAutoSelectIdx] = useState(0)

  // 获取工作区路径
  useEffect(() => {
    async function resolve() {
      let wp: string | null = null
      if (sessionId) {
        // 有会话 → 从会话的 workspace 字段获取
        wp = sessionStore.getSession(sessionId)?.workspace ?? null
      } else {
        // 无会话（新对话）→ 从 chatState.selectedWorkspace 获取
        wp = chatState.value.selectedWorkspace ?? null
      }
      // 如果都没设置，回退到 defaultWorkspace
      if (!wp) {
        wp =
          settingsState.value.defaultWorkspace ??
          (await resolveDefaultWorkspace()) ??
          null
      }
      setWorkspace(wp)
    }
    resolve()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 无会话时：同步 selectedWorkspace 的变更（用户手动切换目录）
  useEffect(() => {
    if (sessionId) return
    const wp = chatState.value.selectedWorkspace
    if (wp && wp !== workspace) {
      setWorkspace(wp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, chatState.value.selectedWorkspace])

  const auto = usePathAutocomplete(value, cursorPos, workspace)

  // 自动补全关闭时重置选中索引
  useEffect(() => {
    if (!auto.visible) setAutoSelectIdx(0)
  }, [auto.visible])

  // 进入新目录时重置选中索引（例如根目录5项选中第4个，进子目录只有2项）
  useEffect(() => {
    setAutoSelectIdx(0)
  }, [auto.items])

  return {
    visible: auto.visible,
    items: auto.items,
    dirLabel: auto.dirLabel,
    relativePrefix: auto.relativePrefix,
    isEmptyDir: auto.isEmptyDir,
    closeAutocomplete: auto.closeAutocomplete,
    autoSelectIdx,
    setAutoSelectIdx,
  }
}
