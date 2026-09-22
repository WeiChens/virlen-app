/**
 * 迭代目标输入行（纯展示）
 *
 * 目标文本的 state 由父组件持有；本组件只负责渲染 + 冒泡事件。
 */
import { t } from '@/ui/i18n'
import GoalQuickInputMenu from './goal-quick-input-menu'

export function GoalInputRow({
  goal,
  onChange,
  onClose,
  onEscape,
  onQuickSelect,
  disabled,
}: {
  goal: string
  onChange: (v: string) => void
  /** 点击关闭按钮 */
  onClose: () => void
  /** Esc：关闭并把焦点交回主输入框 */
  onEscape: () => void
  onQuickSelect: (template: { text: string }) => void
  disabled?: boolean
}) {
  return (
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
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('输入可验证的目标，AI 会自动检查结果...')}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onEscape()
          }
        }}
      />
      {/* 验证目标快捷输入（goal-close-btn 左侧） */}
      <GoalQuickInputMenu onSelect={onQuickSelect} disabled={disabled} />
      <button
        className="goal-close-btn"
        onClick={onClose}
        title={t('关闭迭代模式')}
        type="button">
        ✕
      </button>
    </div>
  )
}
