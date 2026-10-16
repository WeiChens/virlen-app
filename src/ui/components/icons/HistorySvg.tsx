/**
 * HistorySvg — 提交记录图标（Material `history`：时钟 + 逆时针箭头）。
 *
 * 与 `GitSvg` / `RefreshSvg` 同一姿势：纯 **fill** 几何、不写死颜色，由父级 CSS
 * （`.git-icon-btn svg { fill: currentColor }`）给颜色 —— 用 stroke 的图形在那里会变成隐形。
 */
export default function HistorySvg({ fill }: { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200"
      fill={fill}>
      <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
    </svg>
  )
}
