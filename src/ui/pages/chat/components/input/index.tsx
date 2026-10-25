/**
 * 聊天输入框：自动高度 textarea，Enter 发送 / Shift+Enter 换行。AI 工作中仍可输入与上传附件，
 * 只是 Enter 改为换行、发送按钮变停止。
 *
 * 拖拽与粘贴都必须落到真实路径：拖拽走原生 OLE 上报（dragDropEnabled=true，页面收不到 HTML5 drop）；
 * 粘贴问原生剪贴板（paste 事件只给 File，无磁盘路径）。两者汇到 acceptPaths。
 *
 * 具体逻辑在同目录小钩子里，本文件只管编排、键盘分发与 JSX 拼接。
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
import { observer } from 'mobx-react-lite'
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
import ContextMenu, {
  useContextMenu,
} from '@/ui/components/shared/ContextMenu'
import { editableMenuItems } from '@/ui/components/shared/ContextMenu/editable'
import type { Props, RefProps } from './types'
import type { QuoteAttachment } from './hooks'
import './style.scss'

// 附件类型 re-export 供外部使用
export type { ImageAttachment } from './hooks'
export type { FileAttachment } from './hooks'
export type { QuoteAttachment } from './hooks'
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
  // 文本输入（每个 session 独立维护）
  const [value, setValue] = useState(
    () => getSessionInput(sessionId)?.value ?? '',
  )
  const [cursorPos, setCursorPos] = useState(
    () => getSessionInput(sessionId)?.cursorPos ?? 0,
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  /**
   * 输入框右键菜单（剪切 / 复制 / 粘贴 / 全选）：自绘窗口全局禁用了浏览器原生右键菜单，
   * 而原生菜单里全是常用操作，只能自补。菜单项渲染时现算。
   */
  const inputMenu = useContextMenu<void>()

  // 输入框高度拖拽拉伸
  const { wrapperHeight, isResizingState, handleResizeStart } =
    useInputHeight(textareaRef)

  // 附件（图片 / 文件 / 引用 / 技能）
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

  /** 统一入口：一批真实路径 → 图片读字节回图片链路，其余只留路径。 */
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

  // 剪贴板文件（原生读取 + Ctrl+V 兜底）
  const { acceptClipboardFiles, scheduleClipboardFileFallback, pasteSeenRef } =
    useClipboardFiles(acceptPaths)

  // 迭代目标（Goal）
  const [goal, setGoal] = useState(() => getSessionInput(sessionId)?.goal ?? '')
  const [goalExpanded, setGoalExpanded] = useState(
    () => getSessionInput(sessionId)?.goalExpanded ?? false,
  )

  // session 输入状态保存 / 恢复
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
   * 把「当前引用了哪些技能」发布给上层（侧边栏卡片据此高亮）。
   * 回调存 ref：否则父组件每次渲染都传新函数，effect 会反复跑。
   */
  const onSkillsChangeRef = useRef(onSkillsChange)
  onSkillsChangeRef.current = onSkillsChange
  useEffect(() => {
    onSkillsChangeRef.current?.(skills.map((s) => s.name))
  }, [skills])

  // 语音输入：识别结果追加到文本输入框
  const handleSpeechResult = useCallback((text: string) => {
    setValue((prev) => {
      // 前一次有中间结果（含 ⋯）时先回退
      const base = prev.includes('⋯') ? prev.split('⋯')[0] : prev
      return base + text
    })
  }, [])
  const { isRecording, isTranscribing, voiceSupported, toggleVoiceInput } =
    useVoiceInput(handleSpeechResult)

  // 路径自动补全
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

  // 上下文压缩状态
  const compacting = sessionId
    ? sessionRuntimeState.value.sessions[sessionId].compacting
    : false

  // 事件处理器（发送 / 取消 / 粘贴 / 拖拽 / 补全选中 / 快捷输入）
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

  // 暴露给父组件的 API
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
     * 添加一条引用。与 setText 不同：不因 loading 而忽略 —— 引用不改草稿文本；
     * 真正的发送拦截在发送按钮 / handleSend。
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
    /** 按路径挂附件：复用 acceptPaths，与「从系统拖文件进来」同一条路。 */
    attachPaths: (paths: string[]) => {
      if (disabled) return
      void acceptPaths(paths)
    },
    /** 按技能名挂技能引用；不受 loading 限制，读全文是异步的。 */
    attachSkills: (names: string[]) => {
      if (disabled) return
      void addSkills(names)
      if (textareaRef.current) {
        queueMicrotask(() => {
          textareaRef.current!.focus()
        })
      }
    },
    /** 取消引用（同步，不需要聚焦也不受 disabled 限制） */
    detachSkills: (names: string[]) => {
      removeSkillsByName(names)
    },
  }))

  // 自动聚焦
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus()
  }, [disabled])

  // 自动高度（仅增高不缩矮，保留用户手动拉伸）；有固定高度时由 flex 接管
  useEffect(() => {
    if (wrapperHeight) return
    const el = textareaRef.current
    if (!el) return
    // 只有内容实际高度超过当前高度才自动增高
    if (el.scrollHeight > el.clientHeight) {
      el.style.height = Math.min(el.scrollHeight, 250) + 'px'
    }
  }, [value, wrapperHeight])

  // 键盘事件：保留在组件内，补全导航需要 autoItems / autoSelectIdx 且顺序敏感
  function handleKeyDown(e: KeyboardEvent) {
    // 补全打开时的键盘导航
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

    // Ctrl+V：只登记「这一轮要做原生兜底」，不拦默认粘贴
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'v'
    ) {
      scheduleClipboardFileFallback()
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // AI 工作中 / 压缩中：不拦截回车，交给默认行为插换行
      if (loading || compacting) return
      e.preventDefault()
      handlers.handleSend()
      return
    }

    // 输入框为空时，Backspace 依次撤销最后添加的附件（引用 → 文件 → 图片）
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

    // Ctrl+X / Cmd+X：无选区时裁剪当前行（有选区让默认行为处理）
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      const el = textareaRef.current
      if (!el || el.selectionStart !== el.selectionEnd) return

      e.preventDefault()

      const start = el.selectionStart
      const text = value

      const lineStart = text.lastIndexOf('\n', start - 1) + 1
      const lineEndIdx = text.indexOf('\n', start)
      const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx
      const currentLine = text.slice(lineStart, lineEnd)
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

  // 拖拽（原生通道，能拿到真实路径）
  useNativeDragDrop({ acceptPaths, wrapperRef, setIsDragOver })

  // Agent 名称显示（有会话时）
  const agent = agentStore.getAgent(
    sessionStore.getSession(chatState.value.currentSessionId)?.agentId,
  )
  const agentName =
    chatState.value.currentSessionId && agent ? agent.name : undefined

  // 工作中指示器：压缩优先（明确的长任务），否则用业务侧写入的 loadingText（只展示一个状态）
  const workingText = compacting
    ? t('上下文压缩中')
    : chatState.value.loadingText || t('正在工作中')

  return (
    <div className="chat-input">
      {/* 工作中过渡动画指示器 — AI 处理 / 视觉分析 / 上下文压缩时展示 */}
      {(loading || compacting) && (
        <WorkingIndicator workingText={workingText} compacting={compacting} />
      )}

      {/* 输入区自上而下 = 附件条 / 目标行 / textarea / 工具条。拖拽高度只作用于 textarea + 工具条。 */}
      <div
        ref={wrapperRef}
        className={`input-wrapper ${isDragOver ? 'drag-over' : ''} ${wrapperHeight ? 'has-fixed-height' : ''} ${isResizingState ? 'resizing' : ''}`}
        // 侧边栏目录树按此标记找落点：带它的元素才接收「拖进来的文件」
        data-file-drop-zone="true"
        onDragOver={handlers.handleDragOver}
        onDragLeave={handlers.handleDragLeave}
        onDrop={handlers.handleDrop}>
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
            // 拖拽给的是输入区整体高度，textarea 拿走扣掉固定占用的部分
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
          onContextMenu={(e) => {
            // 硬禁用时不开菜单：剪切 / 粘贴都无处落脚（AI 工作中不算硬禁用）
            if (disabled) return
            inputMenu.openAt(e, undefined)
          }}
          placeholder={
            images.length > 0 ||
            files.length > 0 ||
            quotes.length > 0 ||
            skills.length > 0
              ? t('添加描述或直接发送...')
              : placeholder
          }
          disabled={
            // 硬禁用时才禁用输入框；AI 工作中仍可继续输入，只是不能发送
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
          onMessagesUpdate={onMessagesUpdate}
        />

        {/* 输入框右键菜单（portal 挂 body） */}
        {inputMenu.state && (
          <ContextMenu
            position={inputMenu.state.position}
            items={editableMenuItems(textareaRef.current)}
            onClose={inputMenu.close}
          />
        )}
      </div>
    </div>
  )
}

/**
 * ⚠️ 必须是 `observer`（不是 `observable`）：后者把组件包成「可观察对象」，React 仍能渲染，
 * 但 MobX 不会跟踪 render 里读的 store —— 以前靠一条 2s 的 `setInterval` 强制重渲染兜底，
 * 空闲时 loadingText / 工作中状态最多迟到 2 秒。
 */
export default observer(forwardRef(ChatInput))
