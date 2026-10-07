/**
 * Toggle — 通用开关（滑动式 checkbox），三档尺寸 sm / md / lg。
 *
 * 收口被复制了 4~5 份的 `<label class="toggle"> + <span class="toggle-slider">` 写法：
 * 尺寸靠 CSS 变量驱动（宽 / 高 / 滑块直径），位移由 `calc()` 推导 —— 新增尺寸只加一组变量，
 * 不用再手算 `translateX(20px)`。
 *
 * 类名用 `virlen-toggle` 而非 `.toggle`：后者是全局约定类，甚至出现在
 * `.settings-panel .toggle input:focus-visible + .toggle-slider` 这类跨层选择器里，沿用同名
 * 会被意外命中（老页面的 `.toggle` 暂未迁移，二者并存）。
 *
 * 无障碍：`role="switch"` + `aria-checked`；无可见文字标签时**必须**传 `ariaLabel`，
 * 焦点环画在滑块上（checkbox 本体是零尺寸隐藏元素）。
 */
import './style.scss'

/** 尺寸档：sm 用于列表行内，md 为默认（与老 `.toggle` 视觉一致），lg 用于强调场景 */
export type ToggleSize = 'sm' | 'md' | 'lg'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  size?: ToggleSize
  disabled?: boolean
  /** 无障碍名称（无可见文字标签时必填） */
  ariaLabel?: string
  /** 悬停提示（通常写控件作用，如「启用 / 禁用」） */
  title?: string
  /** 追加在根节点上的类名（布局微调用，如间距） */
  className?: string
}

export default function Toggle({
  checked,
  onChange,
  size = 'md',
  disabled = false,
  ariaLabel,
  title,
  className,
}: ToggleProps) {
  return (
    <label
      className={`virlen-toggle size-${size}${
        disabled ? ' is-disabled' : ''
      }${className ? ` ${className}` : ''}`}
      title={title}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="virlen-toggle__slider" aria-hidden="true" />
    </label>
  )
}
