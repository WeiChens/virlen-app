/**
 * PhoneSvg — 手机图标（设置页「手机控制」导航项）。
 * 与既有图标同一约定：`fill` 作为描边色。
 */
export default function PhoneSvg({ fill = 'currentColor' }: { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke={fill}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <line x1="10" y1="18.5" x2="14" y2="18.5" />
    </svg>
  )
}
