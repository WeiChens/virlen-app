/**
 * Toggle — 通用开关（滑动式 checkbox）
 *
 * 为什么要有这个组件：`<label class="toggle"> + <span class="toggle-slider">` 这套写法
 * 在本仓库被复制了 4~5 份（general / editor / provider / security 各自的 scss），
 * 没有尺寸档、也没法统一改。这里给出一份实现 + 三档尺寸（sm / md / lg）。
 *
 * 尺寸靠 CSS 变量驱动（宽 / 高 / 滑块直径），位移量由 `calc()` 推导，
 * 因此新增尺寸只需要加一组变量，不用再手算 `translateX(20px)` 这类硬编码。
 *
 * ⚠️ 类名用 `virlen-toggle` 而不是 `.toggle`：既有页面里 `.toggle` 是**全局约定类**，
 *    甚至出现在 `.settings-panel .toggle input:focus-visible + .toggle-slider`
 *    这种跨层选择器里，沿用同名类会被那些规则意外命中（改一处、别处跟着变）。
 *    老页面的 `.toggle` 暂未迁移，二者可以并存。
 *
 * 无障碍：`role="switch"` + `aria-checked`；没有可见文字标签时**必须**传 `ariaLabel`；
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
