/**
 * 输入框事件处理器 — 发送 / 取消 / 路径补全选中 / 粘贴 / 拖拽 / 快捷输入
 *
 * 抽出的都是「读当前渲染值 → 触发回调」的动作；`handleKeyDown`（键盘分发）
 * 因依赖路径补全项的类型与顺序，仍留在组件内，但会调用这里导出的 handleSend / handlePathSelect。
 *
 * 注意：handleSend / handleCancel 是「每次渲染重建的普通函数」（与拆分前一致），
 * 它们读取的是本次渲染的 value/images/...（即最新值），无闭包过期问题。
 */
import { useCallback } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { chatState, getSessionRuntime } from '@/ui/store'
import { cancelPausedRun } from '@/services/chat-service'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'
import { clearSessionInput } from './session-input-store'
import type {
  FileAttachment,
  ImageAttachment,
  QuoteAttachment,
  SkillAttachment,
} from './hooks'

interface Params {
  sessionId?: string
  value: string
  setValue: (v: string) => void
  cursorPos: number
  setCursorPos: (v: number) => void
  textareaRef: { current: HTMLTextAreaElement | null }
  images: ImageAttachment[]
  files: FileAttachment[]
  quotes: QuoteAttachment[]
  skills: SkillAttachment[]
  goal: string
  disabled?: boolean
  loading?: boolean
  compacting: boolean
  onSend: (
    content: string,
    images?: ImageAttachment[],
    goal?: string,
    files?: FileAttachment[],
    quotes?: QuoteAttachment[],
    skills?: SkillAttachment[],
  ) => void
  onCancel?: () => void
  onMessagesUpdate?: (sessionId: string) => void
  clearImages: () => void
  clearFiles: () => void
  clearQuotes: () => void
  clearSkills: () => void
  setGoal: (v: string) => void
  setGoalExpanded: (v: boolean) => void
  removeQuote: (id: string) => void
  removeFile: (id: string) => void
  removeImage: (id: string) => void
  addImages: (files: FileList | File[]) => Promise<void>
  acceptClipboardFiles: (dt: DataTransfer | null) => Promise<boolean>
  pasteSeenRef: { current: boolean }
  setIsDragOver: (v: boolean) => void
  fileInputRef: { current: HTMLInputElement | null }
  closeAutocomplete: () => void
}

export function useInputHandlers(p: Params) {
  // ===== 发送 =====
  function handleSend() {
    const trimmed = p.value.trim()
    const hasAttachment =
      p.images.length > 0 ||
      p.files.length > 0 ||
      p.quotes.length > 0 ||
      p.skills.length > 0
    if ((!trimmed && !hasAttachment) || p.disabled || p.loading || p.compacting)
      return
    const currentGoal = p.goal.trim() || undefined
    p.onSend(
      trimmed,
      p.images.length > 0 ? p.images : undefined,
      currentGoal,
      p.files.length > 0 ? p.files : undefined,
      p.quotes.length > 0 ? p.quotes : undefined,
      p.skills.length > 0 ? p.skills : undefined,
    )
    p.setValue('')
    p.clearImages()
    p.clearFiles()
    p.clearQuotes()
    p.clearSkills()
    p.setGoal('')
    p.setGoalExpanded(false)
    clearSessionInput(p.sessionId) // 发送后清除已保存状态
    if (p.textareaRef.current) {
      p.textareaRef.current.style.height = ''
    }
  }

  // ===== 取消 / 暂停恢复 =====
  function handleCancel() {
    const sid = chatState.value.currentSessionId
    if (!sid) {
      p.onCancel?.()
      return
    }
    const rt = getSessionRuntime(sid)
    if (rt.paused) {
      cancelPausedRun(sid)
      rt.paused = false
      rt.working = false
      chatState.setValue('loading', false)
      p.onMessagesUpdate?.(sid)
    } else {
      p.onCancel?.()
    }
  }

  // ===== 路径自动补全 — 选中 =====
  const handlePathSelect = useCallback(
    (selectedName: string) => {
      const before = p.value.slice(0, p.cursorPos)
      const lastSpace = Math.max(
        before.lastIndexOf(' '),
        before.lastIndexOf('\n'),
        before.lastIndexOf('\t'),
      )
      const fragmentStart = lastSpace >= 0 ? lastSpace + 1 : 0
      const fragment = before.slice(fragmentStart)

      // 找到 fragment 中 @ 的位置
      const atIdx = fragment.lastIndexOf('@')
      if (atIdx < 0) return

      // 获取 @ 之后的部分，提取正在浏览的目录路径
      const afterAt = fragment.slice(atIdx + 1)
      const slashIdx = afterAt.lastIndexOf('/')
      const dirPart = slashIdx >= 0 ? afterAt.slice(0, slashIdx + 1) : ''

      const isDir = selectedName.endsWith('/')

      let newFragment: string

      if (isDir) {
        // === 选中目录：保留 @，继续嵌套浏览 ===
        // "@" + "src/" + "components/" → "@src/components/"
        newFragment = fragment.slice(0, atIdx + 1) + dirPart + selectedName
        // 不关闭自动补全，useEffect 检测到 text 变化后会重新触发
      } else {
        // === 选中文件：删除 @，插入纯路径 ===
        // "" + "src/" + "main.ts" → "src/main.ts"
        newFragment = fragment.slice(0, atIdx) + dirPart + selectedName
        p.closeAutocomplete()
      }

      const newValue =
        p.value.slice(0, fragmentStart) + newFragment + p.value.slice(p.cursorPos)
      const newPos = fragmentStart + newFragment.length

      // 同时更新 value 和 cursorPos，确保 useEffect 能正确解析新文本
      p.setValue(newValue)
      p.setCursorPos(newPos)

      // 设置 DOM 光标位置
      queueMicrotask(() => {
        p.textareaRef.current?.setSelectionRange(newPos, newPos)
        p.textareaRef.current?.focus()
      })
    },
    [p.value, p.cursorPos, p.closeAutocomplete],
  )

  // ===== 图片选择：点击文件选择器 =====
  const handleImageButtonClick = useCallback(() => {
    p.fileInputRef.current?.click()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        await p.addImages(files)
      }
      // 重置 input 以允许重复选择相同文件
      e.target.value = ''
    },
    [p.addImages],
  )

  // ===== 剪贴板粘贴 =====
  // 图片：剪贴板直接给了内容，沿用原有链路
  // 文件：剪贴板只给 File 拿不到路径，整批交给原生剪贴板读（acceptClipboardFiles）
  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData
      if (!dt) {
        p.pasteSeenRef.current = false
        return
      }

      // 把剪贴板里能给到页面、且我们能消费的东西挑出来
      const imageFiles: File[] = []
      let hasOtherFiles = false
      const items = dt.items
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item.kind !== 'file') continue
          const file = item.getAsFile()
          if (!file) continue
          if (file.type.startsWith('image/')) imageFiles.push(file)
          else hasOtherFiles = true
        }
      }
      const hasText = dt.getData('text/plain').length > 0

      p.pasteSeenRef.current = hasText || imageFiles.length > 0 || hasOtherFiles

      // 页面拿不到磁盘路径，整批走原生链路，免得和下面的图片链路把同一张图挂两遍
      if (hasOtherFiles) {
        e.preventDefault()
        const ok = await p.acceptClipboardFiles(dt)
        if (!ok) showToast(t('无法从剪贴板获取文件路径，请直接把文件拖进输入框'))
        return
      }

      // 剪贴板里是图片内容（截图 / 网页里复制图片）→ 沿用原有上传链路
      if (imageFiles.length > 0) {
        e.preventDefault()
        await p.addImages(imageFiles)
      }
    },
    [p.addImages, p.acceptClipboardFiles, p.pasteSeenRef],
  )

  // ===== 拖拽（浏览器调试模式的兼底）=====
  // Tauri 桌面端 dragDropEnabled=true，页面收不到 HTML5 的 drop，走原生通道
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    p.setIsDragOver(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    p.setIsDragOver(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      p.setIsDragOver(false)
      const dropped = e.dataTransfer?.files
      if (!dropped || dropped.length === 0) return
      const list = Array.from(dropped)
      const imageFiles = list.filter((f) => f.type.startsWith('image/'))
      const otherFiles = list.filter((f) => !f.type.startsWith('image/'))
      if (imageFiles.length > 0) await p.addImages(imageFiles)
      if (otherFiles.length > 0) {
        // HTML5 的 File 对象拿不到磁盘路径，文件附件只能用原生拖拽事件
        showToast(t('浏览器调试模式拿不到文件路径，请在桌面端拖拽文件'))
      }
    },
    [p.addImages, p.setIsDragOver],
  )

  // ===== 快捷输入选择 =====
  const handleQuickInputSelect = useCallback(
    (template: { text: string }) => {
      if (p.loading) return
      p.setValue(template.text)
      if (p.textareaRef.current) {
        queueMicrotask(() => {
          p.textareaRef.current!.focus()
        })
      }
    },
    [p.loading, p.setValue, p.textareaRef],
  )

  // ===== 验证目标快捷输入选择 =====
  const handleGoalQuickInputSelect = useCallback(
    (template: { text: string }) => {
      if (p.loading) return
      p.setGoal(template.text)
      // 聚焦 goal 输入框
      queueMicrotask(() => {
        const goalInput = document.querySelector(
          '.goal-input',
        ) as HTMLInputElement
        goalInput?.focus()
      })
    },
    [p.loading, p.setGoal],
  )

  return {
    handleSend,
    handleCancel,
    handlePathSelect,
    handleImageButtonClick,
    handleFileChange,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleQuickInputSelect,
    handleGoalQuickInputSelect,
  }
}
