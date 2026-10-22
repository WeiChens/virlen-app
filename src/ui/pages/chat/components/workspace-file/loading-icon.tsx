/**
 * 读取中的转圈图标 —— 面板里「在读文件 / 在准备预览 / 在解析模型」共用这一个视觉。
 *
 * 为什么值得单独一个文件：
 * 1. 同一颗转圈要在**五处**出现（读文本、等媒体 blob、等 HTML 预览基址、PDF 打开、模型解析），
 *    各写一个 span 迟早走形（尺寸 / 颜色 / 节奏各不一样）；
 * 2. 它有一条硬约束（`style.scss` 里必须有 `will-change: transform`），写在组件旁边才有人看到：
 *    three 解析 glb、pdfjs 栅格化都会占住主线程，不提升成独立合成层的话动画会跟着停 ——
 *    那就又变回「显示着 loading 但看起来像卡死」。
 *
 * 只管图标，不管布局：外面的 `.wfp-hint` / `.wfp-model-status` 负责居中与文案。
 */
export default function LoadingIcon({ className }: { className?: string }) {
  return (
    <span
      className={className ? `wfp-spinner ${className}` : 'wfp-spinner'}
      // 纯装饰：旁边那行文案才是读屏该念的话（「正在读取文件…」），念两遍反而吵
      aria-hidden="true"
    />
  )
}
