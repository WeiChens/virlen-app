/**
 * chat-input — 聊天输入框
 * 自动高度 textarea，Enter 发送，Shift+Enter 换行
 * loading 时发送按钮变成停止按钮
 * 支持多模态输入：图片上传 / 粘贴 / 拖拽
 * 支持语音输入：使用 Web Speech API（SpeechRecognition）
 *               权限由 Tauri 原生层在启动时预设为 ALLOW，无需用户授权
 *
 * 子组件：AgentSelector / QuickInputMenu / TokenRing
 * hooks：useImageAttachment / useVoiceInput
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
import SendSvg from '@/ui/components/icons/SendSvg'
import StopSvg from '@/ui/components/icons/StopSvg'
import ModelSwitcher from '../modals/model-switcher'
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
import { t } from '@/ui/i18n'
import AgentSelector from './agent-selector'
import QuickInputMenu from './quick-input-menu'
import TokenRing from './token-ring'
import { useImageAttachment, useVoiceInput } from './hooks'
import { usePathAutocomplete, PathAutocomplete } from './path-autocomplete'
import {
  saveSessionInput,
  getSessionInput,
  clearSessionInput,
} from './session-input-store'
import type { ImageAttachment } from './hooks'
import './style.scss'

/** 图片附件（re-export 供外部使用） */
export type { ImageAttachment }

interface Props {
  sessionId?: string
  onSend: (content: string, images?: ImageAttachment[]) => void
  onCancel?: () => void
  onMessagesUpdate?: (sessionId: string) => void
  disabled?: boolean
  loading?: boolean
  placeholder?: string
}

interface RefProps {
  setText: (text: string) => void
}

function ChatInput(
  {
    sessionId,
    onSend,
    onCancel,
    onMessagesUpdate,
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
      return saved ? Math.max(130, Math.min(600, parseInt(saved, 10))) : null
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
    startHRef.current = wrapperRef.current?.offsetHeight ?? 200

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return
      // drag up = delta positive = taller
      const delta = startYRef.current - ev.clientY
      const newH = Math.max(200, Math.min(600, startHRef.current + delta))
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
      } catch {}
    }
  }, [wrapperHeight])

  // ===== 图片附件 =====
  const { images, addImages, removeImage, clearImages, setImages } =
    useImageAttachment()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // ===== session 输入状态保存/恢复（放在 useImageAttachment 之后，确保 images/setImages 可用） =====
  const prevSessionRef = useRef(sessionId)
  const valueRef = useRef(value)
  valueRef.current = value
  const cursorPosRef = useRef(cursorPos)
  cursorPosRef.current = cursorPos
  const imagesRef = useRef(images)
  imagesRef.current = images

  useEffect(() => {
    const prevId = prevSessionRef.current
    if (prevId === sessionId) return

    // 保存上一个 session 的输入状态
    if (prevId != null) {
      saveSessionInput(prevId, {
        value: valueRef.current,
        cursorPos: cursorPosRef.current,
        images: imagesRef.current,
      })
    }
    prevSessionRef.current = sessionId

    // 恢复当前 session 的输入状态（如有）
    const saved = getSessionInput(sessionId)
    setValue(saved?.value ?? '')
    setCursorPos(saved?.cursorPos ?? 0)
    if (saved?.images?.length) {
      setImages(saved.images)
    } else {
      clearImages()
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
  const { isRecording, voiceSupported, toggleVoiceInput } =
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
      el.style.height = Math.min(el.scrollHeight, 400) + 'px'
    }
  }, [value, wrapperHeight])

  // ===== 发送 =====
  function handleSend() {
    const trimmed = value.trim()
    if ((!trimmed && images.length === 0) || disabled || loading || compacting)
      return
    onSend(trimmed, images.length > 0 ? images : undefined)
    setValue('')
    clearImages()
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (loading) {
        // handleCancel()
      } else {
        handleSend()
      }
      return
    }

    // 输入框为空时，Backspace 删除最后一张图片
    if (e.key === 'Backspace' && !value && images.length > 0) {
      e.preventDefault()
      removeImage(images[images.length - 1].id)
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
  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        await addImages(imageFiles)
      }
    },
    [addImages],
  )

  // ===== 拖拽上传 =====
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
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        await addImages(files)
      }
    },
    [addImages],
  )

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

  return (
    <div className="chat-input">
      {/* 工作中过渡动画指示器 — AI 处理 / 视觉分析时展示 */}
      {loading && (
        <div className="working-indicator">
          {/* <span className="working-dot"></span> */}
          <span className="working-text">
            {chatState.value.loadingText || t('正在工作中')}
          </span>
          <span className="working-bouncing-dots">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </div>
      )}
      {compacting && (
        <div className="working-indicator">
          {/* <span className="working-dot"></span> */}
          <span className="working-text">{t('上下文压缩中')}</span>
          <span className="working-bouncing-dots">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </div>
      )}

      <div
        ref={wrapperRef}
        className={`input-wrapper ${isDragOver ? 'drag-over' : ''} ${wrapperHeight ? 'has-fixed-height' : ''} ${isResizingState ? 'resizing' : ''}`}
        style={{
          height: wrapperHeight ? wrapperHeight + 'px' : undefined,
          maxHeight: !sessionId ? 180 + 'px' : undefined,
        }}
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

        {/* 图片预览条 */}
        {images.length > 0 && (
          <div className="image-preview-strip">
            {images.map((img) => (
              <div key={img.id} className="image-preview-item">
                <img
                  src={img.url}
                  alt={img.name || '图片'}
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

        <textarea
          ref={textareaRef}
          value={value}
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
            images.length > 0 ? t('添加描述或直接发送...') : placeholder
          }
          disabled={disabled || compacting}
        />

        <div className="botton-wapper">
          <div className="input-toolbar">
            {/* 图片上传按钮 */}
            <button
              className={`image-btn ${images.length > 0 ? 'has-images' : ''}`}
              onClick={handleImageButtonClick}
              disabled={disabled || loading}
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
                className={`voice-btn ${isRecording ? 'is-recording' : ''}`}
                onClick={toggleVoiceInput}
                disabled={disabled || loading}
                title={isRecording ? t('点击停止录音') : t('语音输入')}
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

            {/* 模型切换 */}
            <ModelSwitcher />

            {/* Agent 选择器（仅无会话时） */}
            {!sessionId && <AgentSelector sessionId={sessionId} />}

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
              className={`send-btn ${loading ? 'is-loading' : (!value.trim() && images.length === 0) || compacting || disabled ? 'disabled' : ''} `}
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
