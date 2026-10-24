/**
 * CompassSvg — 右侧面板开始页的「水位」图标（引导页顶部，纯装饰）。
 *
 * 造型：外圈 + 指针菱形（两段 path，正好对应指南针）。fill 不写死，由使用处 `color` 决定。
 */
export default function CompassSvg({
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
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 1.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4z"
      />
      <path
        fill={fill}
        d="M16.4 7.6l-2.7 6.1-6.1 2.7 2.7-6.1 6.1-2.7zm-4.9 4.9l-.9 2 2-.9.9-2-2 .9z"
      />
    </svg>
  )
}
