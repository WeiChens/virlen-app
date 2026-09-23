/**
 * storage-svg — 存储图标（数据库柱体）
 *
 * 设置侧栏「存储」用。柱体由「矩形 + 上下两个椭圆」拼成，
 * 再用 mask 挖掉两条窄带，形成「多层盘片」的数据库观感。
 * ⚠️ mask 的 id 是固定的：同页面渲染多个实例时它们共用同一份 mask（形状完全一致，结果不变）。
 */
export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200">
      <defs>
        <mask id="virlen-storage-mask">
          <rect x="0" y="0" width="1024" height="1024" fill="#fff" />
          <ellipse cx="512" cy="418" rx="320" ry="34" fill="#000" />
          <ellipse cx="512" cy="590" rx="320" ry="34" fill="#000" />
        </mask>
      </defs>
      <g mask="url(#virlen-storage-mask)">
        <rect x="192" y="256" width="640" height="512" fill={fill} />
        <ellipse cx="512" cy="256" rx="320" ry="128" fill={fill} />
        <ellipse cx="512" cy="768" rx="320" ry="128" fill={fill} />
      </g>
    </svg>
  )
}
