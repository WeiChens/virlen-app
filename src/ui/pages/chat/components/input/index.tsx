/**
 * chat-input — 聊天输入框
 * 自动高度 textarea，Enter 发送，Shift+Enter 换行
 * loading（AI 工作中）仍可输入文字 / 上传图片 / 语音 / 拖拽粘贴附件，
 *   但 Enter 不发送（改为换行）；只有「发送」被禁止，发送按钮变成停止按钮
 * 支持多模态输入：图片上传 / 粘贴 / 拖拽
 * 支持文件附件：拖拽 / 粘贴文件，只记录路径（不拷贝文件内容）
 * 支持技能引用：侧边栏「技能」页签单击 / 拖拽，把 SKILL.md **全文快照**挂进消息
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
 * 拆分说明：状态/事件抽到同目录小文件 —— 高度（use-input-height）、附件（use-attachments）、
 * 剪贴板（use-clipboard-files）、跨会话保存（use-input-session-state）、路径补全
 * （use-path-autocomplete-state）、原生拖放（use-native-drag-drop）、事件处理器
 * （use-input-handlers）；展示组件见 working-indicator / attachment-strips / goal-input-row /
 * input-toolbar。本文件保留：文本 / 高度 / 附件状态编排、键盘分发（handleKeyDown）、
 * 暴露给父组件的 ref API、以及整体 JSX 拼接。
 */
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  forwardRef,
  useImperativeHandle,
} from 'react'
import {
  chatState,
  sessionStore,
  sessionRuntimeState,
  agentStore,
} from '@/ui/store'
import { observable } from 'mobx'
import { t } from '@/ui/i18n'
import { useVoiceInput, isImagePath, normalizeFsPath } from './hooks'
import { PathAutocomplete } from './path-autocomplete'
import { getSessionInput } from './session-input-store'
import { INPUT_CHROME_HEIGHT } from './constants'
import { useInputHeight } from './use-input-height'
import { useAttachments } from './use-attachments'
import { useClipboardFiles } from './use-clipboard-files'
import { useInputSessionState } from './use-input-session-state'
import { usePathAutocompleteState } from './use-path-autocomplete-state'
import { useNativeDragDrop } from './use-native-drag-drop'
import { useInputHandlers } from './use-input-handlers'
import { WorkingIndicator } from './working-indicator'
import {
  FileStrip,
  ImageStrip,
  QuoteStrip,
  SkillStrip,
} from './attachment-strips'
import { GoalInputRow } from './goal-input-row'
import { InputToolbar } from './input-toolbar'
import type { Props, RefProps } from './types'
import type { QuoteAttachment } from './hooks'
import './style.scss'

/** 图片附件（re-export 供外部使用） */
export type { ImageAttachment } from './hooks'
/** 文件附件（re-export 供外部使用） */
export type { FileAttachment } from './hooks'
/** 引用消息（re-export 供外部使用） */
export type { QuoteAttachment } from './hooks'
/** 技能引用（re-export 供外部使用） */
export type { SkillAttachment } from './hooks'

function ChatInput(
  {
    sessionId,
    onSend,
    onCancel,
    onMessagesUpdate,
    onQuoteJump,
    onSkillsChange,
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
  const { wrapperHeight, isResizingState, handleResizeStart } =
    useInputHeight(textareaRef)

  // ===== 附件（图片 / 文件 / 引用 / 技能）=====
  const {
    images,
    setImages,
    addImages,
    addImagePaths,
    removeImage,
    clearImages,
    files,
    setFiles,
    addPaths,
    removeFile,
    clearFiles,
    quotes,
    setQuotes,
    addQuote,
    removeQuote,
    clearQuotes,
    skills,
    setSkills,
    addSkills,
    removeSkill,
    removeSkillsByName,
    clearSkills,
  } = useAttachments()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

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

  // ===== 剪贴板文件（原生读取 + Ctrl+V 兜底） =====
  const { acceptClipboardFiles, scheduleClipboardFileFallback, pasteSeenRef } =
    useClipboardFiles(acceptPaths)

  // ===== 迭代目标（Goal） =====
  const [goal, setGoal] = useState(() => getSessionInput(sessionId)?.goal ?? '')
  const [goalExpanded, setGoalExpanded] = useState(
    () => getSessionInput(sessionId)?.goalExpanded ?? false,
  )

  // ===== session 输入状态保存/恢复 =====
  useInputSessionState({
    sessionId,
    value,
    cursorPos,
    images,
    files,
    quotes,
    skills,
    goal,
    goalExpanded,
    setValue,
    setCursorPos,
    setImages,
    clearImages,
    setFiles,
    clearFiles,
    setQuotes,
    clearQuotes,
    setSkills,
    clearSkills,
    setGoal,
    setGoalExpanded,
  })

  /**
   * 把「当前引用了哪些技能」发布给上层（侧边栏技能卡片据此高亮 / 再点取消）
   *
   * 回调存 ref：父组件每次渲染都会传新函数（持有新闭包），用 ref 后这个 effect
   * 只在 skills 真正变化时跑，不会被父组件的无关重渲带回声。
   */
  const onSkillsChangeRef = useRef(onSkillsChange)
  onSkillsChangeRef.current = onSkillsChange
  useEffect(() => {
    onSkillsChangeRef.current?.(skills.map((s) => s.name))
  }, [skills])

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
  const {
    visible: autoVisible,
    items: autoItems,
    dirLabel: autoDirLabel,
    relativePrefix: autoRelativePrefix,
    isEmptyDir: autoIsEmptyDir,
    closeAutocomplete,
    autoSelectIdx,
    setAutoSelectIdx,
  } = usePathAutocompleteState(value, cursorPos, sessionId)

  // ===== 上下文压缩状态 =====
  const compacting = sessionId
    ? sessionRuntimeState.value.sessions[sessionId].compacting
    : false

  // ===== 事件处理器（发送 / 取消 / 粘贴 / 拖拽 / 补全选中 / 快捷输入）=====
  const handlers = useInputHandlers({
    sessionId,
    value,
    setValue,
    cursorPos,
    setCursorPos,
    textareaRef,
    images,
    files,
    quotes,
    skills,
    goal,
    disabled,
    loading,
    compacting,
    onSend,
    onCancel,
    onMessagesUpdate,
    clearImages,
    clearFiles,
    clearQuotes,
    clearSkills,
    setGoal,
    setGoalExpanded,
    removeQuote,
    removeFile,
    removeImage,
    addImages,
    acceptClipboardFiles,
    pasteSeenRef,
    setIsDragOver,
    fileInputRef,
    closeAutocomplete,
  })

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
    /**
     * 按路径挂附件（侧边栏目录树 → 输入框）
     *
     * 复用 acceptPaths：与「从系统拖文件进来」完全同一条路 ——
     * 图片进图片链路（预览 / 压缩），其余进文件附件（只留路径）。
     */
    attachPaths: (paths: string[]) => {
      if (disabled) return
      void acceptPaths(paths)
    },
    /**
     * 按技能名挂技能引用（侧边栏「技能」页签）
     *
     * 与 attachPaths 同理不受 loading 限制：引用不改草稿文本，AI 工作中也能先摆好。
     * 读全文是异步的，失败（技能被删 / 文件不可读）由 hook 内部提示。
     */
    attachSkills: (names: string[]) => {
      if (disabled) return
      void addSkills(names)
      if (textareaRef.current) {
        queueMicrotask(() => {
          textareaRef.current!.focus()
        })
      }
    },
    /** 取消引用（同步操作，不需要聚焦也不受 disabled 限制） */
    detachSkills: (names: string[]) => {
      removeSkillsByName(names)
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

  // ===== 键盘事件 =====
  // 保留在组件内：补全导航需要 autoItems / autoSelectIdx 且顺序敏感
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
          handlers.handlePathSelect(
            selected.name + (selected.type === 'dir' ? '/' : ''),
          )
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
      handlers.handleSend()
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

  // ===== 拖拽（原生通道，能拿到真实路径）=====
  useNativeDragDrop({ acceptPaths, wrapperRef, setIsDragOver })

  // ===== Agent 名称显示（有会话时） =====
  const agent = agentStore.getAgent(
    sessionStore.getSession(chatState.value.currentSessionId)?.agentId,
  )
  const agentName =
    chatState.value.currentSessionId && agent ? agent.name : undefined

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

  return (
    <div className="chat-input">
      {/* 工作中过渡动画指示器 — AI 处理 / 视觉分析 / 上下文压缩时展示 */}
      {(loading || compacting) && (
        <WorkingIndicator workingText={workingText} compacting={compacting} />
      )}

      {/* 输入框：内容自上而下 = 附件条 / 迭代目标行 / textarea / 工具条。
          盒子本身不写死高度（高度 = 内容高度），「用户拖拽的高度」只作用在输入区
          （textarea + 工具条，见下面 textarea 的 style），
          所以附件再多也只会把盒子往上撑，不会从工具条那里抢空间。 */}
      <div
        ref={wrapperRef}
        className={`input-wrapper ${isDragOver ? 'drag-over' : ''} ${wrapperHeight ? 'has-fixed-height' : ''} ${isResizingState ? 'resizing' : ''}`}
        // 侧边栏目录树用指针拖拽找落点（见 sidebar/use-tree-drag.ts）：
        // 带这个标记的元素才会接收「拖进来的文件」
        data-file-drop-zone="true"
        onDragOver={handlers.handleDragOver}
        onDragLeave={handlers.handleDragLeave}
        onDrop={handlers.handleDrop}>
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
          onChange={handlers.handleFileChange}
        />

        {/* 引用条（只存被引用消息的元数据 + 正文快照） */}
        <QuoteStrip
          quotes={quotes}
          onJump={onQuoteJump}
          onRemove={removeQuote}
        />

        {/* 技能引用条（存 SKILL.md 全文快照） */}
        <SkillStrip skills={skills} onRemove={removeSkill} />

        {/* 文件附件条（只存路径，不拷贝文件） */}
        <FileStrip files={files} onRemove={removeFile} />

        {/* 图片预览条 */}
        <ImageStrip images={images} onRemove={removeImage} />

        {/* 路径自动补全下拉 */}
        {autoVisible && (
          <PathAutocomplete
            items={autoItems}
            dirLabel={autoDirLabel}
            relativePrefix={autoRelativePrefix}
            isEmptyDir={autoIsEmptyDir}
            onSelect={handlers.handlePathSelect}
            onClose={closeAutocomplete}
            selectedIndex={autoSelectIdx}
            setSelectedIndex={setAutoSelectIdx}
          />
        )}

        {/* 迭代目标输入行 */}
        {goalExpanded && (
          <GoalInputRow
            goal={goal}
            onChange={setGoal}
            onClose={() => setGoalExpanded(false)}
            onEscape={() => {
              setGoalExpanded(false)
              textareaRef.current?.focus()
            }}
            onQuickSelect={handlers.handleGoalQuickInputSelect}
            disabled={disabled}
          />
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
          onPaste={handlers.handlePaste}
          placeholder={
            images.length > 0 ||
            files.length > 0 ||
            quotes.length > 0 ||
            skills.length > 0
              ? t('添加描述或直接发送...')
              : placeholder
          }
          disabled={
            // 仅“硬禁用”时才禁用输入框；AI 工作中（loading）仍可继续输入，只是不能发送
            disabled
          }
        />

        <InputToolbar
          sessionId={sessionId}
          agentName={agentName}
          value={value}
          images={images}
          files={files}
          quotes={quotes}
          skills={skills}
          loading={loading}
          compacting={compacting}
          disabled={disabled}
          voiceSupported={voiceSupported}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          toggleVoiceInput={toggleVoiceInput}
          onImageClick={handlers.handleImageButtonClick}
          onQuickInputSelect={handlers.handleQuickInputSelect}
          onClear={() => {
            setValue('')
            textareaRef.current?.focus()
          }}
          onCancel={handlers.handleCancel}
          onSend={handlers.handleSend}
        />
      </div>
    </div>
  )
}

export default observable(forwardRef(ChatInput))
