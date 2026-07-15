/**
 * AppLogoSvg — "微"主题品牌 Logo（入场带动画）
 *
 * 设计理念：
 * - 中心是圆润的「W」字母，代表"微"（Wei）
 * - 左侧蓝色弧线代表 AI 智能流
 * - 右侧绿色弧线代表自然的对话交互
 * - 整体呈现一个抽象的对话气泡 + 大脑轮廓
 * - 配色：渐变的靛蓝 + 翠绿，现代科技感
 * - 入场动画：弹性缩放 + 路径绘制 + 渐入
 */
export default ({
  size = 48,
  className,
}: {
  size?: number
  className?: string
}) => {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wg-main" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
        <linearGradient id="wg-accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#34D399" />
        </linearGradient>
        <linearGradient id="wg-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="100%" stopColor="#fff" />
        </linearGradient>
      </defs>

      {/* 整体容器：淡入 + 弹性缩放 */}
      <g>
        <animateTransform
          attributeName="transform"
          type="scale"
          values="0.7; 1.05; 1"
          keyTimes="0; 0.6; 1"
          dur="0.6s"
          begin="0s"
          fill="freeze"
          calcMode="spline"
          keySplines="0.25 0.1 0.25 1; 0.25 0.1 0.25 1"
        />
        <animate
          attributeName="opacity"
          values="0; 1"
          dur="0.4s"
          begin="0s"
          fill="freeze"
        />

        {/* 背景圆 */}
        <circle cx="60" cy="60" r="55" fill="url(#wg-bg)" opacity="1">
          <animate
            attributeName="opacity"
            values="0; 1"
            dur="0.3s"
            begin="0s"
            fill="freeze"
          />
        </circle>

        {/* 左上弧线 */}
        <path
          d="M20 70 Q15 55 25 40 Q35 25 50 20"
          stroke="url(#wg-main)"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.4">
          <animate
            attributeName="stroke-dasharray"
            values="0 200; 200 0"
            dur="0.8s"
            begin="0.1s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.4 0 0.2 1"
          />
        </path>

        {/* 左上圆点 */}
        <circle cx="50" cy="20" r="3" fill="url(#wg-main)" opacity="0">
          <animate
            attributeName="opacity"
            values="0; 1"
            dur="0.3s"
            begin="0.5s"
            fill="freeze"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 -10; 0 0"
            dur="0.4s"
            begin="0.5s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25 0.1 0.25 1"
          />
        </circle>

        {/* 右下弧线 */}
        <path
          d="M100 50 Q105 65 95 80 Q85 95 70 100"
          stroke="url(#wg-accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.4">
          <animate
            attributeName="stroke-dasharray"
            values="0 200; 200 0"
            dur="0.8s"
            begin="0.2s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.4 0 0.2 1"
          />
        </path>

        {/* 右下圆点 */}
        <circle cx="70" cy="100" r="3" fill="url(#wg-accent)" opacity="0">
          <animate
            attributeName="opacity"
            values="0; 1"
            dur="0.3s"
            begin="0.6s"
            fill="freeze"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 10; 0 0"
            dur="0.4s"
            begin="0.6s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25 0.1 0.25 1"
          />
        </circle>

        {/* 屋顶主路径（W 字母主体） */}
        <path
          d="M38 78 V42 L50 60 L60 44 L70 60 L82 42 V78"
          stroke="url(#wg-main)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none">
          <animate
            attributeName="stroke-dasharray"
            values="0 300; 300 0"
            dur="0.9s"
            begin="0.15s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25 0.1 0.25 1"
          />
        </path>

        {/* 左装饰点 */}
        <circle cx="42" cy="36" r="2.5" fill="url(#wg-accent)" opacity="0">
          <animate
            attributeName="opacity"
            values="0; 1"
            dur="0.25s"
            begin="0.7s"
            fill="freeze"
          />
          <animateTransform
            attributeName="transform"
            type="scale"
            values="0; 1.2; 1"
            dur="0.4s"
            begin="0.7s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25 0.1 0.25 1"
          />
        </circle>

        {/* 右装饰点 */}
        <circle cx="78" cy="36" r="2.5" fill="url(#wg-accent)" opacity="0">
          <animate
            attributeName="opacity"
            values="0; 1"
            dur="0.25s"
            begin="0.75s"
            fill="freeze"
          />
          <animateTransform
            attributeName="transform"
            type="scale"
            values="0; 1.2; 1"
            dur="0.4s"
            begin="0.75s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25 0.1 0.25 1"
          />
        </circle>

        {/* 底部微笑弧线 */}
        <path
          d="M45 88 Q60 96 75 88"
          stroke="url(#wg-accent)"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          opacity="0.5">
          <animate
            attributeName="stroke-dasharray"
            values="0 100; 100 0"
            dur="0.6s"
            begin="0.4s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.4 0 0.2 1"
          />
          <animate
            attributeName="opacity"
            values="0; 0.5"
            dur="0.3s"
            begin="0.4s"
            fill="freeze"
          />
        </path>

        {/* 中心小圆点 */}
        <circle cx="60" cy="58" r="2" fill="url(#wg-main)" opacity="0">
          <animate
            attributeName="opacity"
            values="0; 1"
            dur="0.3s"
            begin="0.85s"
            fill="freeze"
          />
          <animateTransform
            attributeName="transform"
            type="scale"
            values="0; 1.3; 1"
            dur="0.35s"
            begin="0.85s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25 0.1 0.25 1"
          />
        </circle>
      </g>
    </svg>
  )
}
