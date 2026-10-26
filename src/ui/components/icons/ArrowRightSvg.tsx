/**
 * ArrowRightSvg — 右向箭头（横杆 + 大箭头），**只画一个方向**。
 *
 * 用在右侧面板的浏览器标签上：前进用它，后退**旋转 180°**（`.browser-nav-arrow.is-back`）。
 * 不另存一份左箭头：两个方向只差一个 transform，存两份几何就有了两份唯一源（§11.57 ⑬）。
 * 纯 fill 几何、不写死颜色，颜色由父级 CSS 的 `currentColor` 给 —— 按钮禁用时整枚图标一起变淡。
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
        d="M881 562H81c-27.6 0-50-22.4-50-50s22.4-50 50-50h800c27.6 0 50 22.4 50 50s-22.4 50-50 50z"
        fill={fill}
      />
      <path
        d="M907.6 540.7L695.5 328.6c-19.5-19.5-19.5-51.2 0-70.7s51.2-19.5 70.7 0L978.4 470c19.5 19.5 19.5 51.2 0 70.7-19.6 19.6-51.2 19.6-70.8 0z"
        fill={fill}
      />
      <path
        d="M695.5 695.4l212.1-212.1c19.5-19.5 51.2-19.5 70.7 0s19.5 51.2 0 70.7L766.2 766.1c-19.5 19.5-51.2 19.5-70.7 0s-19.5-51.2 0-70.7z"
        fill={fill}
      />
    </svg>
  )
}
