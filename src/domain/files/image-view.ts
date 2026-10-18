/**
 * 图片查看器的**视图变换口径**（纯函数）—— 缩放 / 平移 / 旋转的那点数学只写在这里。
 *
 * 坐标系约定（三处必须一致，否则「拖到哪儿、缩到哪儿」会错）：
 * - `x` / `y`：**相对容器中心**的平移量（屏幕方向，单位 px）；CSS 里写成 `translate(x, y)`；
 * - `scale`：相对「适应窗口」尺寸的倍数，1 = 整张图刚好放进容器；
 * - `rotate`：0 / 90 / 180 / 270。
 *
 * 为什么缩放要绕指针：只有以鼠标为锚点，用户才能按住一个细节连续放大；绕中心缩放会让
 * 目标点在放大过程中不断漂走（截图工具 / 看图软件都是前者）。
 */

/** 一个视图状态（受控于组件，本模块只算新值） */
export interface ImageView {
  /** 相对「适应窗口」的倍数；1 = 适应 */
  scale: number
  /** 0 / 90 / 180 / 270 */
  rotate: number
  /** 相对容器中心的位移（px） */
  x: number
  y: number
}

/** 缩放上下限（相对适应尺寸）：再小看不清，再大只是糊） */
export const IMAGE_MIN_SCALE = 0.1
export const IMAGE_MAX_SCALE = 8

/** 按钮 / 键盘的单步倍率（乘法而不是加法：从 400% 再加 0.25 几乎没有感觉） */
export const IMAGE_SCALE_STEP = 1.25

export const IDENTITY_VIEW: ImageView = { scale: 1, rotate: 0, x: 0, y: 0 }

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value))
  // `Math.min(0, -0)` 会留下 -0：它在 CSS 里无害，但会让「值没变」的判断与用例输出变得可疑
  return clamped === 0 ? 0 : clamped
}

/** 乘一步并夹到上下限（`direction` > 0 放大） */
export function stepScale(scale: number, direction: 1 | -1): number {
  const next = direction > 0 ? scale * IMAGE_SCALE_STEP : scale / IMAGE_SCALE_STEP
  return clamp(next, IMAGE_MIN_SCALE, IMAGE_MAX_SCALE)
}

/**
 * 以某个**屏幕点**（相对容器中心）为锚点缩放到 `scale`。
 *
 * 推导：变换后某点的屏幕位置是 `P = t + s·p`（p 是未缩放坐标），要让它不动：
 * `t' = P − (P − t)·s'/s`。
 */
export function zoomAt(view: ImageView, pointer: { x: number; y: number }, scale: number): ImageView {
  const next = clamp(scale, IMAGE_MIN_SCALE, IMAGE_MAX_SCALE)
  if (next === view.scale) return view
  const ratio = next / view.scale
  return {
    scale: next,
    rotate: view.rotate,
    x: pointer.x - (pointer.x - view.x) * ratio,
    y: pointer.y - (pointer.y - view.y) * ratio,
  }
}

/** 顺时针旋转 `delta` 度（默认 ±90，归一到 0 / 90 / 180 / 270） */
export function rotateView(view: ImageView, delta = 90): ImageView {
  return { ...view, rotate: (((view.rotate + delta) % 360) + 360) % 360 }
}

/**
 * 把平移量夹回「图片边缘不离开容器」的范围。
 *
 * `content` = 图片的**布局**尺寸（未缩放、未旋转），`viewport` = 容器可视区。
 * 旋转 90° / 270° 时宽高互换 —— 漏了这一步，横图转成竖图后只能拖到一半。
 * 尺寸未知（0，首帧 / jsdom）时原样返回：宁可不夹，也不要算出 NaN 把图挤成一条线。
 */
export function clampPan(
  view: ImageView,
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): ImageView {
  const { width: cw, height: ch } = viewport
  const { width: bw, height: bh } = content
  if (!cw || !ch || !bw || !bh) return view
  const swapped = view.rotate % 180 !== 0
  // 图片居中显示：能拖出的距离是「(显示尺寸 − 容器) / 2」，图片比容器小就只能待在中间
  const maxX = Math.max(0, ((swapped ? bh : bw) * view.scale - cw) / 2)
  const maxY = Math.max(0, ((swapped ? bw : bh) * view.scale - ch) / 2)
  const x = clamp(view.x, -maxX, maxX)
  const y = clamp(view.y, -maxY, maxY)
  return x === view.x && y === view.y ? view : { ...view, x, y }
}

/**
 * 「适应窗口」时的真实像素比例（显示用的百分比 = `fitRatio × scale`）。
 *
 * `max-width/max-height: 100%` 只缩不放，所以小图不会被拉大 —— 这里同样封顶 1，
 * 否则一张 16×16 的图标会被报成 300%。
 */
export function fitRatio(
  natural: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  const { width: nw, height: nh } = natural
  const { width: vw, height: vh } = viewport
  if (!nw || !nh || !vw || !vh) return 1
  return Math.min(1, vw / nw, vh / nh)
}

/** 百分比文案（`fitRatio × scale`，最小 1%，避免显示 0%） */
export function scalePercent(ratio: number, scale: number): number {
  return Math.max(1, Math.round(ratio * scale * 100))
}

/** 「实际大小」对应的 scale（图片像素与屏幕像素 1:1）；小图已被封顶，返回 1 即可 */
export function actualSizeScale(ratio: number): number {
  if (!ratio) return 1
  return clamp(1 / ratio, IMAGE_MIN_SCALE, IMAGE_MAX_SCALE)
}
