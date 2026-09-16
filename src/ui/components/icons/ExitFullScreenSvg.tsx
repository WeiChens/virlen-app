/**
 * 退出全屏（收起）图标 —— 四角向内括弧。
 * 与 FullScreenSvg 成对使用（代码块头部的全屏按钮）。
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
        d="M160 384V160h224v96H256v128zM864 384V160H640v96h128v128zM160 640v224h224v-96H256v-128zM864 640v224H640v-96h128v-128z"
        fill={fill}></path>
    </svg>
  )
}
