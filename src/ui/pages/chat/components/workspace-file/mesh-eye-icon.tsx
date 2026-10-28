/**
 * MeshEyeIcon — 网格列表每行的「显示 / 隐藏」图标（睁眼 / 闭眼）。
 *
 * 为什么放这里而不是 `components/icons`：只有 3D 预览的网格列表用得到它，那一层放的是全应用
 * 共享的图标。描边式（线条，不用填充）—— 行里旁边就是文字，填充式图标在 14px 下会糊成一团。
 *
 * ⚠️ 颜色与描边**由 CSS 说了算**（`.wfp-mesh-eye svg` 里的 `fill: none` / `stroke: currentColor`）：
 * `App.css` 有一条全局 `svg { fill: var(--icon-color) }`，而 CSS **盖得住** 下面 svg 上的
 * `fill="none"` 呈现属性（属性权重是 0）—— 只靠属性的话睁眼会被整块填实成一个黑饼。
 */
export default function MeshEyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round">
      {open ? (
        <>
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.7" />
        </>
      ) : (
        <>
          {/* 划一道斜线 = 「看不见」，比画一只闭眼更好认（14px 下闭眼就是一条横线） */}
          <path d="M4 4l16 16" />
          <path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a15.6 15.6 0 0 1-3 3.7" />
          <path d="M6.3 7.4A15.7 15.7 0 0 0 2 12s3.6 6.5 10 6.5c1.2 0 2.3-.2 3.3-.6" />
        </>
      )}
    </svg>
  )
}
