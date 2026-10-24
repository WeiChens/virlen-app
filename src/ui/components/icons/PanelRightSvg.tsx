/**
 * PanelRightSvg — 标题栏「右侧面板」开关（开 = 面板已展开，用 `is-active` 高亮）。
 *
 * 造型：圆角窗 + 右列实心，明确「面板在右边」；fill 走 `currentColor`（`.toolbar-icon-btn` 的继承色）。
 */
export default function PanelRightSvg({
  fill,
  className,
}: {
  fill?: string
  className?: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200">
      <path
        fill={fill}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-13A2.5 2.5 0 0 1 4.5 3zm0 1.8a.7.7 0 0 0-.7.7v13a.7.7 0 0 0 .7.7h15a.7.7 0 0 0 .7-.7v-13a.7.7 0 0 0-.7-.7h-15z"
      />
      <path fill={fill} d="M14.4 5.6h5.4a.6.6 0 0 1 .6.6v11.6a.6.6 0 0 1-.6.6h-5.4V5.6z" />
    </svg>
  )
}
