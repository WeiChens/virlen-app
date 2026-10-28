/**
 * MeshTwistIcon — 网格树分组行左侧的折叠箭头（收起指右、展开指下）。
 *
 * 为什么放这里而不是 `components/icons`：只有 3D 预览的网格树用得到（同 `mesh-eye-icon.tsx`）。
 * 描边式：行首只有 14px，填充式三角在深色预设下会与背景糊在一起。
 *
 * ⚠️ 颜色与描边**由 CSS 说了算**（`.wfp-mesh-twist svg` 的 `fill: none` / `stroke: currentColor`）：
 * `App.css` 有一条全局 `svg { fill: var(--icon-color) }`，而 CSS **盖得住** 这里 svg 上的
 * `fill="none"` 呈现属性（属性权重是 0）—— 只靠属性的话箭头会被填成一个黑饼。
 * 旋转也放 CSS（`.wfp-mesh-twist.is-open svg`）：同一件事不在 tsx 里再写一份角度。
 */
export default function MeshTwistIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}
