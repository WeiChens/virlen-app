/**
 * TerminalSvg — 终端图标（右侧面板开始页「新建终端」入口 / 以后的终端标签）。
 *
 * 造型：圆角窗 + `>_`。fill 不写死，由使用处的 `color` 决定。
 */
export default function TerminalSvg({
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
        d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 1.9a.1.1 0 0 0-.1.1v12a.1.1 0 0 0 .1.1h16a.1.1 0 0 0 .1-.1V6a.1.1 0 0 0-.1-.1H4z"
      />
      <path
        fill={fill}
        d="M6.9 8.2l1.3-1.3 3.9 3.9-3.9 3.9-1.3-1.3 2.6-2.6-2.6-2.6zM12.4 14h4.6v1.9h-4.6V14z"
      />
    </svg>
  )
}
