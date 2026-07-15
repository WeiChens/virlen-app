export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="5" r="1.5" fill={fill} />
      <circle cx="12" cy="12" r="1.5" fill={fill} />
      <circle cx="12" cy="19" r="1.5" fill={fill} />
    </svg>
  )
}
