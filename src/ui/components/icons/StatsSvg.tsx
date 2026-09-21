export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      {/* 柱状 + 趋势线：表达「用量统计」 */}
      <rect x="3" y="13" width="3.4" height="8" rx="1" fill={fill} />
      <rect x="8.8" y="9" width="3.4" height="12" rx="1" fill={fill} />
      <rect x="14.6" y="5" width="3.4" height="16" rx="1" fill={fill} />
      <path
        d="M3 11.2 8.8 7.4l5.8-3 6.4-1.6"
        stroke={fill}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
