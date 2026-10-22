/** 轨迹视图图标：左侧圆点 + 右侧横条，像一张事件记录表。 */
export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200">
      <path
        d="M160 256a64 64 0 1 0 0 128 64 64 0 0 0 0-128zM352 272h544a32 32 0 1 1 0 64H352a32 32 0 1 1 0-64zM160 480a64 64 0 1 0 0 128 64 64 0 0 0 0-128zM352 496h544a32 32 0 1 1 0 64H352a32 32 0 1 1 0-64zM160 704a64 64 0 1 0 0 128 64 64 0 0 0 0-128zM352 720h544a32 32 0 1 1 0 64H352a32 32 0 1 1 0-64z"
        fill={fill ?? 'currentColor'}
      />
    </svg>
  )
}
