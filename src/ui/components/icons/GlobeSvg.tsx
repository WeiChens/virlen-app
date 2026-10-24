/**
 * GlobeSvg — 浏览器图标（右侧面板开始页「浏览器」入口 / 以后的浏览器标签）。
 *
 * 造型：球体 + 经纬线。fill 不写死，由使用处的 `color` 决定。
 */
export default function GlobeSvg({
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
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 1.8c1.2 0 2.6 1.7 3.2 4.3H8.8c.6-2.6 2-4.3 3.2-4.3zM8.4 10h7.2c.1.7.1 1.3.1 2s0 1.3-.1 2H8.4a13 13 0 0 1-.1-2c0-.7 0-1.3.1-2zm-1.8 0H4.3a8.2 8.2 0 0 1 1.8-3.1 11 11 0 0 0 .5 3.1zm0 4a11 11 0 0 0-.5 3.1 8.2 8.2 0 0 1-1.8-3.1h2.3zm5.4 6.2c-1.2 0-2.6-1.7-3.2-4.3h6.4c-.6 2.6-2 4.3-3.2 4.3zm5.4-6.2h2.3a8.2 8.2 0 0 1-1.8 3.1 11 11 0 0 0 .5-3.1h-1zm1.8-4h-2.3a11 11 0 0 0-.5-3.1 8.2 8.2 0 0 1 2.8 3.1z"
      />
    </svg>
  )
}
