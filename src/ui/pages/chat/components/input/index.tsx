/**
 * chat-input — 聊天输入框
 * 自动高度 textarea，Enter 发送，Shift+Enter 换行
 * loading（AI 工作中）仍可输入文字 / 上传图片 / 语音 / 拖拽粘贴附件，
 *   但 Enter 不发送（改为换行）；只有「发送」被禁止，发送按钮变成停止按钮
 * 支持多模态输入：图片上传 / 粘贴 / 拖拽
 * 支持文件附件：拖拽 / 粘贴文件，只记录路径（不拷贝文件内容）
 * 支持语音输入：使用 Web Speech API（SpeechRecognition）
 *               权限由 Tauri 原生层在启动时预设为 ALLOW，无需用户授权
 *
 * 取路径说明（拖拽 / 粘贴都必须落到真实路径）：
 *   拖拽：tauri.conf.json 里 dragDropEnabled=true，页面收不到 HTML5 的 drop 事件，
 *         改由原生拖放上报真实路径（Rust drag_drop 模块的自定义 OLE 目标，
 *         经事件 virlen:drag-drop 下发；比 Tauri 自带的更认 VS Code 等来源）。
 *   粘贴：paste 事件只能给 File（有文件名、无磁盘路径），资源管理器 / VS Code 里复制的文件
 *         在 WebView2 里往往连文本都拿不到，所以路径统一问原生剪贴板
 *         （read_clipboard_file_paths，Windows 走 CF_HDROP 或 VS Code 的 code/file-list）；
 *         “从 uri-list 文本里解析”只作非 Windows 的兜底。
 *   两者最终都汇到 acceptPaths：图片读字节回到图片链路，其余进文件附件（只有路径）。
 *
 * 子组件：AgentSelector / QuickInputMenu / TokenRing
 * hooks：useImageAttachment / useFileAttachment / useQuoteAttachment / useVoiceInput
 */
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
  forwardRef,
  useImperativeHandle,
} from 'react'
import { listen } from '@tauri-apps/api/event'
import SendSvg from '@/ui/components/icons/SendSvg'
import StopSvg from '@/ui/components/icons/StopSvg'
import ModelSwitcher from '../modals/model-switcher'
import ReasoningEffortSlider from '../modals/reasoning-effort-slider'
import {
  chatState,
  sessionStore,
  sessionRuntimeState,
  agentStore,
  getSessionRuntime,
  resolveDefaultWorkspace,
  settingsState,
} from '@/ui/store'
import { observable } from 'mobx'
import { cancelPausedRun } from '@/services/chat-service'
import { showImagePreview } from '@/ui/components/shared/ImagePreview'
import FileChip from '@/ui/components/shared/FileChip'
import QuoteChip from '@/ui/components/shared/QuoteChip'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'
import AgentSelector from './agent-selector'
import QuickInputMenu from './quick-input-menu'
import GoalQuickInputMenu from './goal-quick-input-menu'
import TokenRing from './token-ring'
import {
  useImageAttachment,
  useVoiceInput,
  useFileAttachment,
  useQuoteAttachment,
  isImagePath,
  normalizeFsPath,
  readClipboardFilePaths,
} from './hooks'
import { usePathAutocomplete, PathAutocomplete } from './path-autocomplete'
import {
  saveSessionInput,
  getSessionInput,
  clearSessionInput,
} from './session-input-store'
import type { FileAttachment, ImageAttachment, QuoteAttachment } from './hooks'
import './style.scss'

/** 图片附件（re-export 供外部使用） */
export type { ImageAttachment }
/** 文件附件（re-export 供外部使用） */
export type { FileAttachment }
/** 引用消息（re-export 供外部使用） */
export type { QuoteAttachment }

/** 是否在 Tauri 环境（浏览器调试模式下没有原生拖拽事件） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 原生拖放事件负载（来自 Rust 的 drag_drop 模块）
 * 形状与 Tauri 内置的 DragDropEvent 一致；落点是相对窗口左上角的物理像素。
 */
type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'leave' }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }

/** 像不像一个绝对路径（用于从剪贴板文本里辨认文件路径） */
function looksLikeAbsolutePath(p: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(p) || // Windows 盘符
    p.startsWith('\\\\') || // Windows UNC
    p.startsWith('/') // POSIX / file:// 已归一
  )
}

/**
 * 从剪贴板里捞出文件路径
 *
 * 在资源管理器 / Finder 里「复制文件」后，剪贴板除了文件本体（拿不到路径），
 * 通常还带一份路径文本（text/plain 或 text/uri-list），这里把它解析成路径。
 * 拿不到时返回空数组，由调用方给出提示。
 */
function extractPathsFromClipboard(dt: DataTransfer): string[] {
  const raw = [dt.getData('text/plain'), dt.getData('text/uri-list')]
    .filter(Boolean)
    .join('\n')

  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    let text = line.trim()
    if (!text || text.startsWith('#')) continue
    if (/^file:\/\//i.test(text)) {
      text = decodeURIComponent(text.replace(/^file:\/\//i, ''))
      // /C:/xxx → C:/xxx（Windows 的 file:/// 形式会多一个前导斜杠）
      if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1)
    }
    if (!looksLikeAbsolutePath(text)) continue
    out.push(text)
  }
  return out
}

interface Props {
  sessionId?: string
  onSend: (
    content: string,
    images?: ImageAttachment[],
    goal?: string,
    files?: FileAttachment[],
    quotes?: QuoteAttachment[],
  ) => void
  onCancel?: () => void
  onMessagesUpdate?: (sessionId: string) => void
  /** 点击引用 chip：跳转定位到被引用的原消息 */
  onQuoteJump?: (messageId: string) => void
  disabled?: boolean
  loading?: boolean
  placeholder?: string
}

interface RefProps {
  setText: (text: string) => void
  /** 添加一条引用（消息气泡的「引用」按钮调用），重复引用同一消息会被忽略 */
  addQuote: (quote: QuoteAttachment) => void
}

/**
 * 输入区（textarea + 工具条）的最小高度 —— 拖拽手柄的下限。
 * 与 style.scss 的静止高度一致（125 = 固定占用 58 + textarea 67），
 * 否则第一次拖拽会突然跳高（旧值 170 > 静止高度 125）。
 */
const MIN_HEIGHT = 125

/**
 * 输入区里除 textarea 之外的固定占用：
 *   工具条 36 + 与 textarea 的间距 8 + 上下 padding 12 + 上下边框 2 = 58
 *
 * 拖拽手柄给的是「输入区整体高度」（也是 localStorage 里的历史语义），
 * 但真正被撑开的是 textarea，所以套用到 textarea 上时要扣掉这部分。
 * 对齐 style.scss：.input-wrapper 的静止高度 125 ↔ textarea 的 min-height 67。
 */
const INPUT_CHROME_HEIGHT = 58

/** 波浪动画的字符上限：超长文案退化为静态文案（避免上百个 span + 视觉噪音） */
const WAVE_MAX_CHARS = 20

function ChatInput(
  {
    sessionId,
    onSend,
    onCancel,
    onMessagesUpdate,
    onQuoteJump,
    disabled,
    loading,
    placeholder = t('输入消息...'),
  }: Props,
  ref: React.ForwardedRef<RefProps>,
) {
  // ===== 文本输入（每个 session 独立维护） =====
  const [value, setValue] = useState(
    () => getSessionInput(sessionId)?.value ?? '',
  )
  const [cursorPos, setCursorPos] = useState(
    () => getSessionInput(sessionId)?.cursorPos ?? 0,
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // ===== 输入框高度拖拽拉伸 =====
  const [wrapperHeight, setWrapperHeight] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem('_input_wrapper_height')
      return saved ? Math.max(MIN_HEIGHT, Math.min(600, parseInt(saved, 10))) : null
    } catch {
      return null
    }
  })
  const isResizing = useRef(false)
  const startYRef = useRef(0)
  const startHRef = useRef(0)
  const [isResizingState, setIsResizingState] = useState(false)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isResizing.current = true
    setIsResizingState(true)
    startYRef.current = e.clientY
    // 量的是 textarea（真正被拉伸的元素），但按「输入区整体高度」记账，与 wrapperHeight 语义一致
    const textareaHeight = textareaRef.current?.offsetHeight ?? 0
    startHRef.current =
      (textareaHeight || MIN_HEIGHT - INPUT_CHROME_HEIGHT) + INPUT_CHROME_HEIGHT

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return
      // drag up = delta positive = taller
      const delta = startYRef.current - ev.clientY
      const newH = Math.max(MIN_HEIGHT, Math.min(600, startHRef.current + delta))
      setWrapperHeight(newH)
    }

    function onMouseUp() {
      if (!isResizing.current) return
      isResizing.current = false
      setIsResizingState(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  // 持久化高度
  useEffect(() => {
    if (wrapperHeight) {
      try {
        localStorage.setItem('_input_wrapper_height', String(wrapperHeight))
      } catch { }
    }
  }, [wrapperHeight])

  // ===== 图片附件 =====
  const {
    images,
    addImages,
    addImagePaths,
    removeImage,
    clearImages,
    setImages,
  } = useImageAttachment()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // ===== 文件附件（只存路径） =====
  const { files, setFiles, addPaths, removeFile, clearFiles } =
    useFileAttachment()

  // ===== 引用消息（只存 id + 发送方 + 正文快照） =====
  const { quotes, setQuotes, addQuote, removeQuote, clearQuotes } =
    useQuoteAttachment()

  /**
   * 统一入口：一批真实路径 → 按类型分发
   * 图片走原有上传链路（读字节→压缩→预览），其余走文件链路（只留路径）
   */
  const acceptPaths = useCallback(
    async (rawPaths: string[]) => {
      if (rawPaths.length === 0) return
      const paths = rawPaths.map(normalizeFsPath)
      const imagePaths = paths.filter(isImagePath)
      const filePaths = paths.filter((p) => !isImagePath(p))
      if (imagePaths.length > 0) await addImagePaths(imagePaths)
      if (filePaths.length > 0) await addPaths(filePaths)
    },
    [addImagePaths, addPaths],
  )

  /**
   * 把剪贴板里的文件挂成附件
   *
   * 路径优先问原生要：Windows 上「复制文件」的真身是剪贴板里的 CF_HDROP（资源管理器）
   * 或 code/file-list（VS Code），页面的 DataTransfer 只剩一个没有路径的 File。
   * 原生拿不到时（macOS / Linux / 浏览器调试模式）退回页面给的路径文本。
   *
   * @returns 是否真的挂上了附件（调用方据此决定要不要提示用户）
   */
  const acceptClipboardFiles = useCallback(
    async (dt: DataTransfer | null) => {
      const nativePaths = await readClipboardFilePaths()
      const paths =
        nativePaths.length > 0
          ? nativePaths
          : dt
            ? extractPathsFromClipboard(dt)
            : []
      if (paths.length === 0) return false
      await acceptPaths(paths)
      return true
    },
    [acceptPaths],
  )

  // 本轮 Ctrl+V 是否已经由 paste 事件处理（原生兜底用，见 scheduleClipboardFileFallback）
  const pasteSeenRef = useRef(false)
  const pasteFallbackTimerRef = useRef<number | null>(null)

  /**
   * Ctrl+V 的原生兜底
   *
   * 资源管理器里复制的文件，在 WebView2 里可能连 paste 事件都不触发
   * （对页面而言剪贴板是“空的”，默认粘贴也没东西可插），只在 paste 事件里做就漏一半。
   * 策略：这里不拦默认粘贴，只在下一轮事件循环里确认 paste 事件确实没来、
   * 而剪贴板里真有文件时才补挂一次附件——正常粘贴文字 / 图片完全不受影响。
   */
  const scheduleClipboardFileFallback = useCallback(() => {
    pasteSeenRef.current = false
    if (pasteFallbackTimerRef.current !== null) {
      window.clearTimeout(pasteFallbackTimerRef.current)
    }
    pasteFallbackTimerRef.current = window.setTimeout(() => {
      pasteFallbackTimerRef.current = null
      if (pasteSeenRef.current) return
      void acceptClipboardFiles(null)
    }, 0)
  }, [acceptClipboardFiles])

  // 卸载时清掉待触发的兜底定时器
  useEffect(
    () => () => {
      if (pasteFallbackTimerRef.current !== null) {
        window.clearTimeout(pasteFallbackTimerRef.current)
      }
    },
    [],
  )

  // ===== session 输入状态保存/恢复（放在 useImageAttachment 之后，确保 images/setImages 可用） =====
  const prevSessionRef = useRef(sessionId)
  const valueRef = useRef(value)
  valueRef.current = value
  const cursorPosRef = useRef(cursorPos)
  cursorPosRef.current = cursorPos
  const imagesRef = useRef(images)
  imagesRef.current = images
  const filesRef = useRef(files)
  filesRef.current = files
  const quotesRef = useRef(quotes)
  quotesRef.current = quotes

  // ===== 迭代目标（Goal） =====
  const [goal, setGoal] = useState(
    () => getSessionInput(sessionId)?.goal ?? '',
  )
  const [goalExpanded, setGoalExpanded] = useState(
    () => getSessionInput(sessionId)?.goalExpanded ?? false,
  )
  const goalRef = useRef(goal)
  goalRef.current = goal
  const goalExpandedRef = useRef(goalExpanded)
  goalExpandedRef.current = goalExpanded

  useEffect(() => {
    const prevId = prevSessionRef.current
    if (prevId === sessionId) return

    // 保存上一个 session 的输入状态
    if (prevId != null) {
      saveSessionInput(prevId, {
        value: valueRef.current,
        cursorPos: cursorPosRef.current,
        images: imagesRef.current,
        files: filesRef.current,
        quotes: quotesRef.current,
        goal: goalRef.current,
        goalExpanded: goalExpandedRef.current,
      })
    }
    prevSessionRef.current = sessionId

    // 恢复当前 session 的输入状态（如有）
    const saved = getSessionInput(sessionId)
    setValue(saved?.value ?? '')
    setCursorPos(saved?.cursorPos ?? 0)
    setGoal(saved?.goal ?? '')
    setGoalExpanded(saved?.goalExpanded ?? false)
    if (saved?.images?.length) {
      setImages(saved.images)
    } else {
      clearImages()
    }
    if (saved?.files?.length) {
      setFiles(saved.files)
    } else {
      clearFiles()
    }
    if (saved?.quotes?.length) {
      setQuotes(saved.quotes)
    } else {
      clearQuotes()
    }
  }, [sessionId])

  // 组件卸载时保存（例如关闭标签页）
  useEffect(() => {
    return () => {
      if (sessionId != null) {
        saveSessionInput(sessionId, {
          value: valueRef.current,
          cursorPos: cursorPosRef.current,
          images: imagesRef.current,
          files: filesRef.current,
          quotes: quotesRef.current,
          goal: goalRef.current,
          goalExpanded: goalExpandedRef.current,
        })
      }
    }
  }, [sessionId])

  // ===== 语音输入 =====
  // 语音识别结果 → 追加到文本输入框
  const handleSpeechResult = useCallback((text: string) => {
    setValue((prev) => {
      // 如果前一次有中间结果（含 ⋯），需要先回退
      const base = prev.includes('⋯') ? prev.split('⋯')[0] : prev
      return base + text
    })
  }, [])
  const { isRecording, isTranscribing, voiceSupported, toggleVoiceInput } =
    useVoiceInput(handleSpeechResult)

  // ===== 路径自动补全 =====
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [autoSelectIdx, setAutoSelectIdx] = useState(0)

  // 获取工作区路径（与 chat-view.tsx 的 WorkspaceDisplay 保持一致的来源）
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
  }, [sessionId])

  // 无会话时：同步 selectedWorkspace 的变更（用户手动切换目录）
  useEffect(() => {
    if (sessionId) return
    const wp = chatState.value.selectedWorkspace
    if (wp && wp !== workspace) {
      setWorkspace(wp)
    }
  }, [sessionId, chatState.value.selectedWorkspace])

  const {
    visible: autoVisible,
    items: autoItems,
    dirLabel: autoDirLabel,
    relativePrefix: autoRelativePrefix,
    isEmptyDir: autoIsEmptyDir,
    closeAutocomplete,
  } = usePathAutocomplete(value, cursorPos, workspace)

  // 自动补全关闭时重置选中索引
  useEffect(() => {
    if (!autoVisible) setAutoSelectIdx(0)
  }, [autoVisible])

  // 进入新目录时重置选中索引（例如根目录5项选中第4个，进子目录只有2项）
  useEffect(() => {
    setAutoSelectIdx(0)
  }, [autoItems])

  // ===== 上下文压缩状态 =====
  const compacting = sessionId
    ? sessionRuntimeState.value.sessions[sessionId].compacting
    : false

  // ===== 暴露给父组件的 API =====
  useImperativeHandle(ref, () => ({
    setText: (text: string) => {
      if (loading) return
      setValue(text)
      if (textareaRef.current) {
        queueMicrotask(() => {
          textareaRef.current!.focus()
        })
      }
    },
    /**
     * 添加一条引用（消息气泡的「引用」按钮调用）
     *
     * 与 setText 不同，这里**不**因 loading 而忽略：引用不修改已有草稿文本，
     * AI 工作中照样可以先摆好引用条；真正的发送拦截在发送按钮 / handleSend。
     */
    addQuote: (quote: QuoteAttachment) => {
      if (disabled) return
      addQuote(quote)
      if (textareaRef.current) {
        queueMicrotask(() => {
          textareaRef.current!.focus()
        })
      }
    },
  }))

  // ===== 自动聚焦 =====
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus()
  }, [disabled])

  // ===== 自动高度（仅增高不缩矮，保留用户手动拉伸）=====
  // 当 wrapper 有固定高度时，由 flex 布局接管，禁用自动高度
  useEffect(() => {
    if (wrapperHeight) return
    const el = textareaRef.current
    if (!el) return
    // 只有当内容实际高度超过当前高度时才自动增高，不主动缩矮
    if (el.scrollHeight > el.clientHeight) {
      el.style.height = Math.min(el.scrollHeight, 250) + 'px'
    }
  }, [value, wrapperHeight])

  // ===== 发送 =====
  function handleSend() {
    const trimmed = value.trim()
    const hasAttachment =
      images.length > 0 || files.length > 0 || quotes.length > 0
    if ((!trimmed && !hasAttachment) || disabled || loading || compacting)
      return
    const currentGoal = goal.trim() || undefined
    onSend(
      trimmed,
      images.length > 0 ? images : undefined,
      currentGoal,
      files.length > 0 ? files : undefined,
      quotes.length > 0 ? quotes : undefined,
    )
    setValue('')
    clearImages()
    clearFiles()
    clearQuotes()
    setGoal('')
    setGoalExpanded(false)
    clearSessionInput(sessionId) // 发送后清除已保存状态
    if (textareaRef.current) {
      textareaRef.current.style.height = ''
    }
  }

  // ===== 取消 / 暂停恢复 =====
  function handleCancel() {
    const sid = chatState.value.currentSessionId
    if (!sid) {
      onCancel?.()
      return
    }
    const rt = getSessionRuntime(sid)
    if (rt.paused) {
      cancelPausedRun(sid)
      rt.paused = false
      rt.working = false
      chatState.setValue('loading', false)
      onMessagesUpdate?.(sid)
    } else {
      onCancel?.()
    }
  }

  // ===== 路径自动补全 — 选中 =====
  const handlePathSelect = useCallback(
    (selectedName: string) => {
      const before = value.slice(0, cursorPos)
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
        closeAutocomplete()
      }

      const newValue =
        value.slice(0, fragmentStart) + newFragment + value.slice(cursorPos)
      const newPos = fragmentStart + newFragment.length

      // 同时更新 value 和 cursorPos，确保 useEffect 能正确解析新文本
      setValue(newValue)
      setCursorPos(newPos)

      // 设置 DOM 光标位置
      queueMicrotask(() => {
        textareaRef.current?.setSelectionRange(newPos, newPos)
        textareaRef.current?.focus()
      })
    },
    [value, cursorPos, closeAutocomplete],
  )

  // ===== 键盘事件 =====
  function handleKeyDown(e: KeyboardEvent) {
    // 自动补全打开时的键盘导航
    if (autoVisible && autoItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAutoSelectIdx((prev) => (prev + 1) % autoItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAutoSelectIdx(
          (prev) => (prev - 1 + autoItems.length) % autoItems.length,
        )
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const selected = autoItems[autoSelectIdx]
        if (selected) {
          handlePathSelect(selected.name + (selected.type === 'dir' ? '/' : ''))
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeAutocomplete()
        return
      }
    }

    // Ctrl+V / Cmd+V：只登记「这一轮要做原生兜底」，不拦默认粘贴（见 scheduleClipboardFileFallback）
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'v'
    ) {
      scheduleClipboardFileFallback()
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // AI 工作中 / 上下文压缩中：不拦截回车，交给默认行为插入换行（此时也禁止发送）
      if (loading || compacting) return
      e.preventDefault()
      handleSend()
      return
    }

    // 输入框为空时，Backspace 依次撤销最后添加的附件（引用优先，其次文件、图片，
    // 顺序与附件条的视觉排列一致：上面的先被撤销）
    if (e.key === 'Backspace' && !value) {
      if (quotes.length > 0) {
        e.preventDefault()
        removeQuote(quotes[quotes.length - 1].messageId)
        return
      }
      if (files.length > 0) {
        e.preventDefault()
        removeFile(files[files.length - 1].id)
        return
      }
      if (images.length > 0) {
        e.preventDefault()
        removeImage(images[images.length - 1].id)
      }
    }

    // Ctrl+X / Cmd+X: 无选区时裁剪当前行
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      const el = textareaRef.current
      if (!el || el.selectionStart !== el.selectionEnd) return // 有选区时让默认行为处理

      e.preventDefault()

      const start = el.selectionStart
      const text = value

      // 找到行首（前一个换行符之后）
      const lineStart = text.lastIndexOf('\n', start - 1) + 1
      // 找到行尾（下一个换行符，或文本末尾）
      const lineEndIdx = text.indexOf('\n', start)
      const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx
      // 当前行内容（不含换行符）
      const currentLine = text.slice(lineStart, lineEnd)
      // 去掉当前行及其后的换行符
      const afterNewline = lineEndIdx === -1 ? text.length : lineEndIdx + 1
      const newText = text.slice(0, lineStart) + text.slice(afterNewline)

      navigator.clipboard.writeText(currentLine)

      setValue(newText)
      setCursorPos(lineStart)

      queueMicrotask(() => {
        el.setSelectionRange(lineStart, lineStart)
        el.focus()
      })
    }
  }

  // ===== 图片选择：点击文件选择器 =====
  const handleImageButtonClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        await addImages(files)
      }
      // 重置 input 以允许重复选择相同文件
      e.target.value = ''
    },
    [addImages],
  )

  // ===== 剪贴板粘贴 =====
  // 图片：剪贴板直接给了内容，沿用原有链路
  // 文件：剪贴板只给 File 拿不到路径，整批交给原生剪贴板读（acceptClipboardFiles）
  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData
      if (!dt) {
        pasteSeenRef.current = false
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

      pasteSeenRef.current = hasText || imageFiles.length > 0 || hasOtherFiles

      // 页面拿不到磁盘路径，整批走原生链路，免得和下面的图片链路把同一张图挂两遍
      if (hasOtherFiles) {
        e.preventDefault()
        const ok = await acceptClipboardFiles(dt)
        if (!ok) showToast(t('无法从剪贴板获取文件路径，请直接把文件拖进输入框'))
        return
      }

      // 剪贴板里是图片内容（截图 / 网页里复制图片）→ 沿用原有上传链路
      if (imageFiles.length > 0) {
        e.preventDefault()
        await addImages(imageFiles)
      }
    },
    [addImages, acceptClipboardFiles],
  )

  // ===== 拖拽（浏览器调试模式的兼底）=====
  // Tauri 桌面端 dragDropEnabled=true，页面收不到 HTML5 的 drop，走下面的原生通道
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])
  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])
  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      const dropped = e.dataTransfer?.files
      if (!dropped || dropped.length === 0) return
      const list = Array.from(dropped)
      const imageFiles = list.filter((f) => f.type.startsWith('image/'))
      const otherFiles = list.filter((f) => !f.type.startsWith('image/'))
      if (imageFiles.length > 0) await addImages(imageFiles)
      if (otherFiles.length > 0) {
        // HTML5 的 File 对象拿不到磁盘路径，文件附件只能用原生拖拽事件
        showToast(t('浏览器调试模式拿不到文件路径，请在桌面端拖拽文件'))
      }
    },
    [addImages],
  )

  // ===== 拖拽（原生通道，能拿到真实路径）=====
  // 事件来自 Rust 的 drag_drop 模块（自定义 OLE 拖放目标），按落点是否在输入框内决定接不接。
  useEffect(() => {
    if (!isTauriEnv()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    /** 落点是否在输入框内（事件给的是物理像素，需换算成 CSS 像素） */
    const isInsideInput = (position: { x: number; y: number }) => {
      const el = wrapperRef.current
      if (!el) return false
      const rect = el.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const x = position.x / ratio
      const y = position.y / ratio
      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      )
    }

    listen<DragDropPayload>('virlen:drag-drop', (event) => {
      const payload = event.payload
      if (payload.type === 'enter' || payload.type === 'over') {
        setIsDragOver(isInsideInput(payload.position))
      } else if (payload.type === 'leave') {
        setIsDragOver(false)
      } else if (payload.type === 'drop') {
        setIsDragOver(false)
        // 拖进来的不是文件（如拖选中的文本）：paths 为空，交给系统/页面原有行为，不插手
        if (!payload.paths || payload.paths.length === 0) return
        // 落在输入框外：不静默丢弃，给个提示，否则用户会以为功能没生效
        if (!isInsideInput(payload.position)) {
          showToast(t('请把文件拖到输入框内'))
          return
        }
        void acceptPaths(payload.paths)
      }
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {
        // 非 Tauri 环境 / 事件不可用
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [acceptPaths])

  // ===== 快捷输入选择 =====
  const handleQuickInputSelect = useCallback(
    (template: { text: string }) => {
      if (loading) return
      setValue(template.text)
      if (textareaRef.current) {
        queueMicrotask(() => {
          textareaRef.current!.focus()
        })
      }
    },
    [loading],
  )

  // ===== 验证目标快捷输入选择 =====
  const handleGoalQuickInputSelect = useCallback(
    (template: { text: string }) => {
      if (loading) return
      setGoal(template.text)
      // 聚焦 goal 输入框
      queueMicrotask(() => {
        const goalInput = document.querySelector(
          '.goal-input',
        ) as HTMLInputElement
        goalInput?.focus()
      })
    },
    [loading],
  )

  // ===== Agent 名称显示（有会话时） =====
  const agent = agentStore.getAgent(
    sessionStore.getSession(chatState.value.currentSessionId)?.agentId,
  )

  // ===== 定时刷新（同步 store 变化到 UI） =====
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      forceUpdate((n) => n + 1)
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  // ===== 工作中指示器文案 =====
  // 压缩优先（它是一次明确的长任务），否则用业务侧写入的 loadingText
  // 单一文案来源：loading 与 compacting 同时为真时只展示一个状态
  const workingText = compacting
    ? t('上下文压缩中')
    : chatState.value.loadingText || t('正在工作中')

  // 波浪文字：拆成单字（Array.from 能正确处理 emoji / 代理对，不像 split('') 会拆碎）
  const waveChars = Array.from(workingText)

  return (
    <div className="chat-input">
      {/* 工作中过渡动画指示器 — AI 处理 / 视觉分析 / 上下文压缩时展示
          波浪文字：逐字上下呼吸、靠相位差形成波峰横向推进，无装饰点
          逐字 span 对读屏隐藏，完整文案由 aria-label 承载，避免逐字被拆读
          注：`|| true` 是临时预览开关，提交前删掉 */}
      {(loading || compacting) && (
        <div
          className={`working-indicator ${compacting ? 'is-compacting' : ''}`}
          role="status"
          aria-live="polite"
          aria-label={workingText}>
          {waveChars.length <= WAVE_MAX_CHARS ? (
            <span className="working-wave" aria-hidden="true">
              {waveChars.map((ch, i) => (
                <span
                  key={`${i}-${ch}`}
                  className="working-wave-char"
                  // 相位差 = 第几个字 × 波浪步长（负数：上屏即处在自己那一拍，避免开头「闪一下」）
                  // 步长定义在 style.scss 的 --wave-step，调节奏只动一处
                  style={{
                    animationDelay: `calc(${i - waveChars.length} * var(--wave-step))`,
                  }}>
                  {ch === ' ' ? '\u00a0' : ch}
                </span>
              ))}
            </span>
          ) : (
            <span className="working-text" aria-hidden="true">
              {workingText}
            </span>
          )}
        </div>
      )}

      {/* 输入框：内容自上而下 = 附件条 / 迭代目标行 / textarea / 工具条。
          盒子本身不写死高度（高度 = 内容高度），「用户拖拽的高度」只作用在输入区
          （textarea + 工具条，见下面 textarea 的 style），
          所以附件再多也只会把盒子往上撑，不会从工具条那里抢空间。 */}
      <div
        ref={wrapperRef}
        className={`input-wrapper ${isDragOver ? 'drag-over' : ''} ${wrapperHeight ? 'has-fixed-height' : ''} ${isResizingState ? 'resizing' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}>
        {sessionId && (
          <div
            className="input-resize-handle"
            onMouseDown={handleResizeStart}
            title={t('拖拽调整输入框高度')}>
            <div className="resize-handle-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {/* 引用条（只存被引用消息的元数据 + 正文快照） */}
        {quotes.length > 0 && (
          <div className="quote-preview-strip">
            {quotes.map((q) => (
              <QuoteChip
                key={q.messageId}
                role={q.role}
                text={q.text}
                messageId={q.messageId}
                onClick={
                  onQuoteJump ? () => onQuoteJump(q.messageId) : undefined
                }
                onRemove={() => removeQuote(q.messageId)}
              />
            ))}
          </div>
        )}

        {/* 文件附件条（只存路径，不拷贝文件） */}
        {files.length > 0 && (
          <div className="file-preview-strip">
            {files.map((f) => (
              <FileChip
                key={f.id}
                path={f.path}
                name={f.name}
                isDir={f.isDir}
                size={f.size}
                onRemove={() => removeFile(f.id)}
              />
            ))}
          </div>
        )}

        {/* 图片预览条 */}
        {images.length > 0 && (
          <div className="image-preview-strip">
            {images.map((img) => (
              <div key={img.id} className="image-preview-item">
                <img
                  src={img.url}
                  alt={img.name || t('图片')}
                  onClick={() =>
                    showImagePreview({
                      src: img.url,
                      previewSrcList: images.map((i) => i.url),
                    })
                  }
                />
                <button
                  className="image-preview-remove"
                  onClick={() => removeImage(img.id)}
                  title={t('移除图片')}
                  type="button">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 路径自动补全下拉 */}
        {autoVisible && (
          <PathAutocomplete
            items={autoItems}
            dirLabel={autoDirLabel}
            relativePrefix={autoRelativePrefix}
            isEmptyDir={autoIsEmptyDir}
            onSelect={handlePathSelect}
            onClose={closeAutocomplete}
            selectedIndex={autoSelectIdx}
            setSelectedIndex={setAutoSelectIdx}
          />
        )}

        {/* 迭代目标输入行 */}
        {goalExpanded && (
          <div className="goal-input-row">
            <span className="goal-icon">
              <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor">
                <path d="M512 416a96 96 0 1 0 96 96 96 96 0 0 0-96-96z m0 160a64 64 0 1 1 64-64 64 64 0 0 1-64 64z" />
                <path d="M512 64a448 448 0 1 0 448 448A448 448 0 0 0 512 64z m-60.32 794.72a351.04 351.04 0 0 1-286.4-286.4A64 64 0 0 0 205.92 528h50.88A256 256 0 0 0 496 768v50.88a64 64 0 0 0-44.32 39.84z m120.64-693.44a351.04 351.04 0 0 1 286.4 286.4A64 64 0 0 0 818.08 496H768a256 256 0 0 0-240-239.2v-50.88a64 64 0 0 0 44.32-40.64zM688 528h48a224 224 0 0 1-208 208v-48a16 16 0 0 0-32 0v48a224 224 0 0 1-207.2-208H336a16 16 0 0 0 0-32h-47.2A224 224 0 0 1 496 288.8V336a16 16 0 0 0 32 0v-47.2A224 224 0 0 1 736 496h-48a16 16 0 0 0 0 32zM451.68 165.28A64 64 0 0 0 496 205.92v50.88A256 256 0 0 0 256.8 496h-50.88a64 64 0 0 0-40.64-44.32 351.04 351.04 0 0 1 286.4-286.4z m120.64 693.44A64 64 0 0 0 528 818.08V768a256 256 0 0 0 240-240h50.88a64 64 0 0 0 40.64 44.32 351.04 351.04 0 0 1-287.2 286.4z" />
              </svg>
            </span>
            <input
              className="goal-input"
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('输入可验证的目标，AI 会自动检查结果...')}
              disabled={disabled}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setGoalExpanded(false)
                  textareaRef.current?.focus()
                }
              }}
            />
            {/* 验证目标快捷输入（goal-close-btn 左侧） */}
            <GoalQuickInputMenu
              onSelect={handleGoalQuickInputSelect}
              disabled={disabled}
            />
            <button
              className="goal-close-btn"
              onClick={() => setGoalExpanded(false)}
              title={t('关闭迭代模式')}
              type="button"
            >
              ✕
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          style={{
            // 拖拽给的是「输入区」整体高度，textarea 拿走扣掉固定占用的部分
            height: wrapperHeight
              ? wrapperHeight - INPUT_CHROME_HEIGHT + 'px'
              : undefined,
            // 欢迎页（还没有会话）不给太高的输入区：整块 180 → textarea 上限 122
            maxHeight: !sessionId ? 180 - INPUT_CHROME_HEIGHT + 'px' : undefined,
          }}
          onChange={(e) => {
            setValue(e.target.value)
            setCursorPos(e.target.selectionStart)
          }}
          onSelect={(e) => {
            setCursorPos(e.currentTarget.selectionStart)
          }}
          onClick={(e) => {
            setCursorPos(e.currentTarget.selectionStart)
          }}
          onKeyUp={(e) => {
            // 方向键移动时同步光标位置
            if (
              e.key === 'ArrowLeft' ||
              e.key === 'ArrowRight' ||
              e.key === 'ArrowUp' ||
              e.key === 'ArrowDown' ||
              e.key === 'Home' ||
              e.key === 'End'
            ) {
              setCursorPos(e.currentTarget.selectionStart)
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            images.length > 0 || files.length > 0 || quotes.length > 0
              ? t('添加描述或直接发送...')
              : placeholder
          }
          disabled={
            // 仅“硬禁用”时才禁用输入框；AI 工作中（loading）仍可继续输入，只是不能发送
            disabled
          }
        />

        <div className="botton-wapper">
          <div className="input-toolbar">
            {/* 图片上传按钮 */}
            <button
              className={`image-btn ${images.length > 0 ? 'has-images' : ''}`}
              onClick={handleImageButtonClick}
              disabled={disabled}
              title={t('上传图片（支持粘贴 / 拖拽）')}
              type="button">
              <svg
                viewBox="0 0 1024 1024"
                version="1.1"
                xmlns="http://www.w3.org/2000/svg"
                p-id="7193"
                width="200"
                height="200">
                <path
                  d="M736 448c53 0 96-43 96-96 0-53-43-96-96-96-53 0-96 43-96 96C640 405 683 448 736 448z"
                  p-id="7194"></path>
                <path
                  d="M904 128 120 128c-31.2 0-56 25.4-56 56.6l0 654.8c0 31.2 24.8 56.6 56 56.6l784 0c31.2 0 56-25.4 56-56.6L960 184.6C960 153.4 935.2 128 904 128zM697.8 523.4c-6-7-15.2-12.4-25.6-12.4-10.2 0-17.4 4.8-25.6 11.4l-37.4 31.6c-7.8 5.6-14 9.4-23 9.4-8.6 0-16.4-3.2-22-8.2-2-1.8-5.6-5.2-8.6-8.2L448 430.6c-8-9.2-20-15-33.4-15-13.4 0-25.8 6.6-33.6 15.6L128 736.4 128 215.4c2-13.6 12.6-23.4 26.2-23.4l715.4 0c13.8 0 25 10.2 25.8 24l0.6 520.8L697.8 523.4z"
                  p-id="7195"></path>
              </svg>
              {images.length > 0 && (
                <span className="image-badge">{images.length}</span>
              )}
            </button>

            {/* 语音输入按钮 */}
            {voiceSupported && (
              <button
                className={`voice-btn ${isRecording ? 'is-recording' : ''} ${isTranscribing ? 'is-transcribing' : ''
                  }`}
                onClick={toggleVoiceInput}
                disabled={disabled || isTranscribing}
                title={
                  isTranscribing
                    ? t('语音识别中...')
                    : isRecording
                      ? t('点击停止录音')
                      : t('语音输入')
                }
                type="button">
                <svg
                  viewBox="0 0 1024 1024"
                  width="16"
                  height="16"
                  xmlns="http://www.w3.org/2000/svg">
                  <path d="M512 128c-53 0-96 43-96 96v256c0 53 43 96 96 96s96-43 96-96V224c0-53-43-96-96-96z" />
                  <path d="M704 480c0 106-86 192-192 192s-192-86-192-192H256c0 141.6 107.4 258.4 245.3 272.8V896h-64V960h149.3v-64h-64V752.8C660.6 738.4 768 621.6 768 480h-64z" />
                </svg>
              </button>
            )}

            {/* 迭代模式切换按钮 */}
            {/* <button
              className={`goal-btn ${goalExpanded ? 'is-active' : ''}`}
              onClick={() => {
                setGoalExpanded(!goalExpanded)
                if (!goalExpanded) {
                  // 展开时聚焦 goal input
                  queueMicrotask(() => {
                    const goalInput = document.querySelector('.goal-input') as HTMLInputElement
                    goalInput?.focus()
                  })
                }
              }}
              disabled={disabled || loading}
              title={goalExpanded ? t('关闭迭代验证模式') : t('开启迭代验证模式：AI 自动检查并修正结果')}
              type="button"
            >
              <svg viewBox="0 0 1024 1024" width="15" height="15" fill="currentColor">
                <path d="M512 416a96 96 0 1 0 96 96 96 96 0 0 0-96-96z m0 160a64 64 0 1 1 64-64 64 64 0 0 1-64 64z" />
                <path d="M512 64a448 448 0 1 0 448 448A448 448 0 0 0 512 64z m-60.32 794.72a351.04 351.04 0 0 1-286.4-286.4A64 64 0 0 0 205.92 528h50.88A256 256 0 0 0 496 768v50.88a64 64 0 0 0-44.32 39.84z m120.64-693.44a351.04 351.04 0 0 1 286.4 286.4A64 64 0 0 0 818.08 496H768a256 256 0 0 0-240-239.2v-50.88a64 64 0 0 0 44.32-40.64zM688 528h48a224 224 0 0 1-208 208v-48a16 16 0 0 0-32 0v48a224 224 0 0 1-207.2-208H336a16 16 0 0 0 0-32h-47.2A224 224 0 0 1 496 288.8V336a16 16 0 0 0 32 0v-47.2A224 224 0 0 1 736 496h-48a16 16 0 0 0 0 32zM451.68 165.28A64 64 0 0 0 496 205.92v50.88A256 256 0 0 0 256.8 496h-50.88a64 64 0 0 0-40.64-44.32 351.04 351.04 0 0 1 286.4-286.4z m120.64 693.44A64 64 0 0 0 528 818.08V768a256 256 0 0 0 240-240h50.88a64 64 0 0 0 40.64 44.32 351.04 351.04 0 0 1-287.2 286.4z" />
              </svg>
            </button> */}

            {/* 模型切换 */}
            <ModelSwitcher />


            {/* Agent 选择器（仅无会话时） */}
            {!sessionId && <AgentSelector sessionId={sessionId} />}
            {/* 推理强度拖动条（档位来自服务商配置） */}
            <ReasoningEffortSlider />
            {/* 当前 Agent 名称（有会话时） */}
            {chatState.value.currentSessionId && agent && (
              <div className="agent-name">{agent.name}</div>
            )}

          </div>

          <div className="input-right">
            {/* 快捷输入 */}
            {!value && (
              <QuickInputMenu
                loading={loading}
                onSelect={handleQuickInputSelect}
              />
            )}

            {/* 清空输入按钮 */}
            {value && (
              <button
                className="clear-input-btn"
                onClick={() => {
                  setValue('')
                  textareaRef.current?.focus()
                }}
                title={t('清空输入')}
                type="button">
                <svg viewBox="0 0 1024 1024" width="16" height="16">
                  <path
                    d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m165.4 618.2l-66-0.1L512 563.4l-99.3 118.7-66.1 0.1c-4.4 0-8-3.5-8-8 0-1.9 0.7-3.7 1.9-5.2l130.1-155L340.5 359c-1.2-1.5-1.9-3.3-1.9-5.2 0-4.4 3.6-8 8-8l66.1 0.1L512 460.6l99.3-118.7 66-0.1c4.4 0 8 3.5 8 8 0 1.9-0.7 3.7-1.9 5.2L553.3 514l130 155c1.2 1.5 1.9 3.3 1.9 5.2 0.1 4.4-3.5 8-7.8 8z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            )}

            {/* Token 环形进度条 */}
            <TokenRing
              sessionId={sessionId}
              compacting={compacting}
              loading={loading}
            />

            {/* 发送 / 停止按钮 */}
            <ripple-button
              className={`send-btn ${loading ? 'is-loading' : (!value.trim() && images.length === 0 && files.length === 0 && quotes.length === 0) || compacting || disabled ? 'disabled' : ''} `}
              onClick={loading ? handleCancel : handleSend}
              title={loading ? t('停止') : t('发送 (Enter)')}>
              {loading ? (
                <StopSvg className="stop" />
              ) : (
                <SendSvg fill="var(--btn-primary-color, #fff)" />
              )}
            </ripple-button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default observable(forwardRef(ChatInput))
