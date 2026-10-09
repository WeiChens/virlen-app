/**
 * ServerSvg — 后台服务图标（聊天页标题栏「后台服务」入口）。
 *
 * 造型：两格机架 + 每格一颗指示灯（用 evenodd 挖空，不依赖父级底色 —— 深色主题下也是洞）。
 * fill 不写死：标题栏按钮靠 `.toolbar-icon-btn svg { fill: currentColor }` 上色。
 */
export default function ServerSvg({ fill }: { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200">
      <path
        fill={fill}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 4h14a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 4zM5 14h14a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 14zM5.6 7a.9.9 0 1 1 1.8 0 .9.9 0 1 1-1.8 0zM5.6 17a.9.9 0 1 1 1.8 0 .9.9 0 1 1-1.8 0z"
      />
    </svg>
  )
}
