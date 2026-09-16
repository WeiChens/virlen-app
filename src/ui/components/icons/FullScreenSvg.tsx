/**
 * 全屏（展开）图标 —— 四角向外括弧。
 * 与 ExitFullScreenSvg 成对使用（代码块头部的全屏按钮）。
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
      <path
        d="M160 160h256v96H256v160h-96zM864 160H608v96h160v160h96zM160 864v-256h96v160h160v96zM864 864h-256v-96h160v-160h96z"
        fill={fill}></path>
    </svg>
  )
}
