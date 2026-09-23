/** 拖拽把手（竖向 6 点 grip）。用于列表排序的可拖区域，非按钮语义的提示图标。 */
export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg">
      <g fill={fill}>
        <circle cx="6" cy="3.5" r="1.4" />
        <circle cx="10" cy="3.5" r="1.4" />
        <circle cx="6" cy="8" r="1.4" />
        <circle cx="10" cy="8" r="1.4" />
        <circle cx="6" cy="12.5" r="1.4" />
        <circle cx="10" cy="12.5" r="1.4" />
      </g>
    </svg>
  )
}
