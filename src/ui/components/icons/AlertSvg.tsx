/**
 * AlertSvg — 3D 预览工具栏「异常日志」的图标（三角警示 + 叹号）。
 *
 * 造型：圆角三角形 + 挖空的叹号（`evenodd`，不依赖父级底色 —— 深色主题下也是洞）。
 * fill 不写死：按钮靠 `.wfp-model-log-btn svg { fill: currentColor }` 上色，
 * 有错误时整颗图标跟着变红（不看徽标也能注意到）。
 */
export default function AlertSvg({ fill }: { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24">
      <path
        fill={fill}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.9 3.4a1.3 1.3 0 0 1 2.2 0l8.6 15.2a1.3 1.3 0 0 1-1.1 1.95H3.4a1.3 1.3 0 0 1-1.1-1.95zM11 8.9h2v5.6h-2zM11 16.3h2v2.2h-2z"
      />
    </svg>
  )
}
