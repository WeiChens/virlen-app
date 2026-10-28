export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200">
      {/* 两层「服务器机架」：MCP 是外部工具服务器的接入点 */}
      <path
        d="M160 128h704a96 96 0 0 1 96 96v192a96 96 0 0 1-96 96H160a96 96 0 0 1-96-96V224a96 96 0 0 1 96-96z m64 128a64 64 0 1 0 0 128 64 64 0 0 0 0-128z"
        fill={fill}
      />
      <path
        d="M160 544h704a96 96 0 0 1 96 96v192a96 96 0 0 1-96 96H160a96 96 0 0 1-96-96V640a96 96 0 0 1 96-96z m64 128a64 64 0 1 0 0 128 64 64 0 0 0 0-128z"
        fill={fill}
      />
    </svg>
  )
}
