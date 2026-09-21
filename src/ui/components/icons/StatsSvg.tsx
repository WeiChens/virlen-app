export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      xmlns="http://www.w3.org/2000/svg">
      {/* 三根高度递增的圆角柱：表达「用量随时间增长」 */}
      <rect x="3" y="14.5" width="3.8" height="6" rx="1.9" fill={fill} />
      <rect x="9.2" y="10.5" width="3.8" height="10" rx="1.9" fill={fill} />
      <rect x="15.4" y="6.5" width="3.8" height="14" rx="1.9" fill={fill} />
      {/* 柱顶的数据点连成上升趋势。
          只填充圆、不用 stroke：图标靠全局 `svg { fill: var(--icon-color) }` 着色，
          而 `stroke={fill}` 在 fill 为 undefined 时会被省略 → 线条不可见（旧版折线即如此）。 */}
      <circle cx="4.9" cy="11.6" r="1.5" fill={fill} />
      <circle cx="11.1" cy="7.6" r="1.5" fill={fill} />
      <circle cx="17.3" cy="3.6" r="1.5" fill={fill} />
    </svg>
  )
}
