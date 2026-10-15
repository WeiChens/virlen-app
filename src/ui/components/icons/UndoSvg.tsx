/**
 * UndoSvg — 撤销 / 还原（左向弧形箭头，造型取自 Material `undo`）。
 *
 * 用在「源代码管理」变更行的**丢弃更改**上：那里原先写的是字符 `↺`（U+21BA），与刷新图标同形 ——
 * 用户会把「丢掉这个文件的改动」读成「刷新一下」（实测反馈）。纯 **fill** 几何，
 * 与 `GitSvg` 一样不写死颜色，交给父级 CSS（`.git-row-btn svg` 已经给了尺寸与 `currentColor`）。
 */
export default function UndoSvg({ fill, className }: { fill?: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200"
      fill={fill}>
      <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
    </svg>
  )
}
