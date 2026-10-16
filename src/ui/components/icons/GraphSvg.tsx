/**
 * GraphSvg — 提交图图标（标题栏 / 面板「提交图」入口）。
 *
 * 造型：左侧主干三个提交节点，两条分叉斜带连到右侧两个节点（与 `GitSvg` 的区别是**两条**分叉、
 * 更「网」一些）。纯 **fill** 几何（圆 + 矩形带），不用 stroke：`.git-icon-btn svg { fill: currentColor }`
 * 只给 fill 上色，用 stroke 的图形在那里会变成隐形。与 `GitSvg` / `HistorySvg` 同一姿势，不写死颜色。
 */
export default function GraphSvg({ fill }: { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200"
      fill={fill}>
      {/* 主干与其上的三个提交节点 */}
      <circle cx="5" cy="4.6" r="2.3" />
      <circle cx="5" cy="12" r="2.3" />
      <circle cx="5" cy="19.4" r="2.3" />
      <path d="M3.85 4.6h2.3v14.8h-2.3z" />
      {/* 上面的分叉：从主干中段斜向右上 */}
      <path d="M17.6 5.02 6.94 10.17 5.74 7.66 16.4 2.51z" />
      {/* 下面的分叉：从主干中段斜向右下 */}
      <path d="M17.6 18.98 6.94 13.83 5.74 16.34 16.4 21.49z" />
      <circle cx="18.6" cy="4.6" r="2.3" />
      <circle cx="18.6" cy="19.4" r="2.3" />
    </svg>
  )
}
