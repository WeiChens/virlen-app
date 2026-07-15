/**
 * AppLogoSvg — "微"主题品牌 Logo
 *
 * 设计理念：
 * - 中心是圆润的「W」字母，代表"微"（Wei）
 * - 左侧蓝色弧线代表 AI 智能流
 * - 右侧绿色弧线代表自然的对话交互
 * - 整体呈现一个抽象的对话气泡 + 大脑轮廓
 * - 配色：渐变的靛蓝 + 翠绿，现代科技感
 */
export default ({ size = 48, className }: { size?: number; className?: string }) => {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 渐变定义 */}
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
          <stop offset="0%" stopColor="#EEF2FF" />
          <stop offset="100%" stopColor="#F0FDF4" />
        </linearGradient>
      </defs>

      {/* 背景圆 — 柔和渐变 */}
      <circle cx="60" cy="60" r="55" fill="url(#wg-bg)" opacity="0.7" />

      {/* 外圈装饰弧线 — 左侧智能流 */}
      <path
        d="M20 70 Q15 55 25 40 Q35 25 50 20"
        stroke="url(#wg-main)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.4"
      />
      <circle cx="50" cy="20" r="3" fill="url(#wg-main)" opacity="0.6" />

      {/* 外圈装饰弧线 — 右侧对话流 */}
      <path
        d="M100 50 Q105 65 95 80 Q85 95 70 100"
        stroke="url(#wg-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.4"
      />
      <circle cx="70" cy="100" r="3" fill="url(#wg-accent)" opacity="0.6" />

      {/* W 字母主体 */}
      <path
        d="M38 78 V42 L50 60 L60 44 L70 60 L82 42 V78"
        stroke="url(#wg-main)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* W 顶部两点装饰 — AI 神经元 */}
      <circle cx="42" cy="36" r="2.5" fill="url(#wg-accent)" opacity="0.8" />
      <circle cx="78" cy="36" r="2.5" fill="url(#wg-accent)" opacity="0.8" />

      {/* 底部连接线 — 对话底座 */}
      <path
        d="M45 88 Q60 96 75 88"
        stroke="url(#wg-accent)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        opacity="0.5"
      />

      {/* 中心亮点 */}
      <circle cx="60" cy="58" r="2" fill="url(#wg-main)" opacity="0.3" />
    </svg>
  )
}
