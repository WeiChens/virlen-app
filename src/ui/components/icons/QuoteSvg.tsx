export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg">
      {/* 箭头头部 */}
      <path d="M3.2 8 6.8 4.4V11.6L3.2 8Z" fill={fill} />
      {/* 回折的箭头杆 */}
      <path
        d="M6.8 7.2H11.2A3.2 3.2 0 0 1 14.4 10.4V12.4H12.8V10.4A1.6 1.6 0 0 0 11.2 8.8H6.8Z"
        fill={fill}
      />
    </svg>
  )
}
