/**
 * 3D 模型预览的「取景主体」判定（**纯数据**：不 import three，也不碰 DOM）。
 *
 * 为什么单独一个文件：取景规则要能被单测钉住，而 `model-scene.ts` 一旦被 import
 * 就会把 three 拉进用例（jsdom 里没有 WebGL，起不来）。这里只吃数字、吐数字。
 *
 * ⚠️ 为什么需要它（实测案例 `black_demon_castle.glb`）：导出时把**星光散布**（1400 个
 * 散落三角面，包围盒 498×238×480）和**远景碎石**（317×39×288）与城堡主体放在同一个根节点下。
 * 直接对整棵子树取包围盒，最长边由 498 决定 —— 主体（铁塔 35×73×51）被缩到只占画面 1/7，
 * 面板里看到的就是白底正中一个小黑点。
 *
 * 判别口径：**尺寸离群者不是主体**。按每个网格自身包围盒的对角线长度取中位数，
 * 超过 `OUTLIER_RATIO` 倍中位数的视为天空盒 / 远景散布物，剔除后求并集。
 * 这条规则不看名字、不看材质，对任何导出器都成立（名字里有没有 `Sky` / `Star` 不可靠）。
 */

/** 一根轴对齐包围盒（数组形式，便于跨模块传递而不用带 three 的类型） */
export interface BoxSpan {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}

/** 超过中位数这么多倍的对角线 = 不是主体（3 倍：能容下一条明显更长的塔尖，又拦得住天空盒） */
const OUTLIER_RATIO = 3

function diagonal(span: BoxSpan): number {
  const dx = span.max[0] - span.min[0]
  const dy = span.max[1] - span.min[1]
  const dz = span.max[2] - span.min[2]
  return Math.hypot(dx, dy, dz)
}

function merge(spans: readonly BoxSpan[]): BoxSpan {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const span of spans) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], span.min[axis])
      max[axis] = Math.max(max[axis], span.max[axis])
    }
  }
  return { min, max }
}

/**
 * 取景主体：剔除尺寸离群网格后的并集。
 * 网格数 ≤ 2 时无从判断离群（单网格模型、或只有一组主体），直接全并。
 * 全部被判为离群时退回全并 —— 宁可框住整棵树，也不要空盒子。
 */
export function subjectSpan(spans: readonly BoxSpan[]): BoxSpan | null {
  const valid = spans.filter(
    (span) =>
      span.max[0] >= span.min[0] && span.max[1] >= span.min[1] && span.max[2] >= span.min[2],
  )
  if (valid.length === 0) return null
  if (valid.length <= 2) return merge(valid)

  const diagonals = valid.map(diagonal).sort((a, b) => a - b)
  const middle = Math.floor(diagonals.length / 2)
  const median =
    diagonals.length % 2 === 0
      ? (diagonals[middle - 1] + diagonals[middle]) / 2
      : diagonals[middle]
  // 中位数为 0（一堆退化网格）：没有尺度可比，退回全并
  if (!(median > 0)) return merge(valid)

  const limit = median * OUTLIER_RATIO
  const kept = valid.filter((span) => diagonal(span) <= limit)
  return merge(kept.length > 0 ? kept : valid)
}
