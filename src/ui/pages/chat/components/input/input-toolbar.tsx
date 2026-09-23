/**
 * 输入框底部工具条（纯展示）
 *
 * 左：图片 / 语音 / 模型 / Agent / 推理强度；右：快捷输入 / 清空 / Token 环 / 发送。
 * 所有状态与回调由父组件注入，本组件不含任何 hook 状态。
 */
import SendSvg from '@/ui/components/icons/SendSvg'
import StopSvg from '@/ui/components/icons/StopSvg'
import ModelSwitcher from '../modals/model-switcher'
import ReasoningEffortSlider from '../modals/reasoning-effort-slider'
import { t } from '@/ui/i18n'
import AgentSelector from './agent-selector'
import QuickInputMenu from './quick-input-menu'
import TokenRing from './token-ring'
import type {
  FileAttachment,
  ImageAttachment,
  QuoteAttachment,
  SkillAttachment,
} from './hooks'

export function InputToolbar({
  sessionId,
  agentName,
  value,
  images,
  files,
  quotes,
  skills,
  loading,
  compacting,
  disabled,
  voiceSupported,
  isRecording,
  isTranscribing,
  toggleVoiceInput,
  onImageClick,
  onQuickInputSelect,
  onClear,
  onCancel,
  onSend,
  onMessagesUpdate,
}: {
  sessionId?: string
  /** 有会话且有 Agent 时展示的 Agent 名称；undefined 表示不展示 */
  agentName?: string
  value: string
  images: ImageAttachment[]
  files: FileAttachment[]
  quotes: QuoteAttachment[]
  skills: SkillAttachment[]
  loading?: boolean
  compacting: boolean
  disabled?: boolean
  voiceSupported: boolean
  isRecording: boolean
  isTranscribing: boolean
  toggleVoiceInput: () => void
  onImageClick: () => void
  onQuickInputSelect: (template: { text: string }) => void
  onClear: () => void
  onCancel: () => void
  onSend: () => void
  /** 压缩后通知上层重新同步消息列表（TokenRing 透传） */
  onMessagesUpdate?: (sessionId: string) => void
}) {
  return (
    <div className="botton-wapper">
      <div className="input-toolbar">
        {/* 图片上传按钮 */}
        <button
          className={`image-btn ${images.length > 0 ? 'has-images' : ''}`}
          onClick={onImageClick}
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
        {agentName !== undefined && (
          <div className="agent-name">{agentName}</div>
        )}

      </div>

      <div className="input-right">
        {/* 快捷输入 */}
        {!value && (
          <QuickInputMenu loading={loading} onSelect={onQuickInputSelect} />
        )}

        {/* 清空输入按钮 */}
        {value && (
          <button
            className="clear-input-btn"
            onClick={onClear}
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
          onMessagesUpdate={onMessagesUpdate}
        />

        {/* 发送 / 停止按钮 */}
        <ripple-button
          className={`send-btn ${loading ? 'is-loading' : (!value.trim() && images.length === 0 && files.length === 0 && quotes.length === 0 && skills.length === 0) || compacting || disabled ? 'disabled' : ''} `}
          onClick={loading ? onCancel : onSend}
          title={loading ? t('停止') : t('发送 (Enter)')}>
          {loading ? (
            <StopSvg className="stop" />
          ) : (
            <SendSvg fill="var(--btn-primary-color, #fff)" />
          )}
        </ripple-button>
      </div>
    </div>
  )
}
