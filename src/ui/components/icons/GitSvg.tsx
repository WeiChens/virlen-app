/**
 * GitSvg — 源代码管理图标（聊天页标题栏入口）。
 *
 * 造型：三个提交节点（左上下 + 右）由主干与一条分叉线连起来 —— 纯 **fill** 几何（圆 + 两条矩形带），
 * 不用 stroke：标题栏按钮只给 `svg { fill: currentColor }` 上色，用 stroke 的图形在那里会变成隐形。
 * 与 `ServerSvg` 一样不写死 fill，交给父级 CSS。
 */
export default function GitSvg({ fill }: { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200"
      fill={fill}>
      {/* 主干与其上的两个提交节点 */}
      <circle cx="7" cy="5" r="2.4" />
      <circle cx="7" cy="19" r="2.4" />
      <path d="M5.9 5h2.2v14H5.9z" />
      {/* 分叉：斜带从主干下半段伸出，连到右侧节点 */}
      <path d="M17.41 11.31 8.41 15.41 7.59 13.59 16.59 9.49z" />
      <circle cx="17" cy="8" r="2.4" />
    </svg>
  )
}
