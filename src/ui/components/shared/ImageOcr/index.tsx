/**
 * ImageOcr —— 图片预览里的「识别文字」层。
 *
 * 口径（两处图片预览共用：大图浮层 `ImagePreview` 与工作目录 `ImageViewer`）：
 * 1. **只做 OCR**：文本与文本框坐标来自 `vision_ocr`（不做视觉识别），见 `hooks/useImageOcr`；
 * 2. **默认不显示**：层盖在图上，但初始是收起的（`visible = false`）—— 要看再点工具栏；
 * 3. **文字摆在原位且透明**：每个文本框一个绝对定位的 `<span>`，`color: transparent`，
 *    只有 `::selection` 才看得见 —— 用户在图上**原位置拖选**，复制到的是真文字（不是图片）。
 *    字号 = 这一行在屏幕上的像素高（容器查询单位 `cqh`），所以缩放 / 改窗口都自动跟随，不用 JS 量尺寸；
 * 4. **每种状态都有话说**：识别中（前面带转圈）/ 没文字 / 失败各一条小提示 —— 静默等于「点了没反应」；
 * 5. **层不挡图**：层本身 `pointer-events: none`（空白处拖动 / 滚轮缩放照旧），
 *    只有文字行与底部小条吃事件；
 * 6. **摆不出位置就退回纯文本**：老缓存没有框、或 EXIF 方向让坐标系对不上时，
 *    宁可给一块可复制的纯文本面板，也不把字摆到错的位置上；
 * 7. **跨行拖选粘出来是多行**：每行都是独立的绝对定位元素，浏览器序列化这种选区时**不补换行**
 *    （选了两行、粘出来挤成一行），所以 `copy` 由本层自己接管：按**框的几何**拼 ——
 *    同一行（重叠 > 75%）之间补空格，不同行之间按拉开的高度补 1..N 个换行
 *    （见 [`lineSeparator`] / [`selectedLinesText`] / `useCopyAsLines`）；
 * 8. **文字层里右键 = 复制 / 全选**：本地窗口全局屏蔽了系统右键菜单，让给系统等于什么都没有
 *    （见 [`ocrTextMenuItems`]，两处预览各自把菜单摆在自己的 ContextMenu 里）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { t } from '@/ui/i18n'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import type { ImageOcrBox, ImageOcrSize } from '@/infrastructure/vision/types'
import { textMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'
import type { ImageOcrState } from '@/ui/hooks/useImageOcr'
import './style.scss'

/** 有可显示的文字（工具栏据此决定点击是「收起/展开」还是「跑一次」） */
export function hasOcrText(state: ImageOcrState): boolean {
  return state.status === 'done' && state.text.trim().length > 0
}

/** 工具栏按钮要不要出现：`idle` = 没图可识别（SVG / 未打开），其余状态都给入口 */
export function canOcr(state: ImageOcrState): boolean {
  return state.status !== 'idle'
}

/** 工具栏按钮的 tooltip：识别中 / 还没识别 / 展开或收起 */
export function ocrButtonTitle(state: ImageOcrState, visible: boolean): string {
  if (state.status === 'loading') return t('正在识别文字…')
  if (!hasOcrText(state)) return t('识别文字')
  return visible ? t('隐藏识别文字') : t('显示识别文字')
}

/**
 * 点一下工具栏按钮的下一步：
 * - 有文字 → 收起 / 展开（不再跑推理）；
 * - 识别中 → 只把层展开，等结果自己落进来；
 * - 就绪（没开自动识别）/ 没读出字 / 失败 → 展开并开始识别。
 */
export function nextOcrAction(
  state: ImageOcrState,
  visible: boolean,
): { visible: boolean; run: boolean } {
  if (hasOcrText(state)) return { visible: !visible, run: false }
  if (state.status === 'loading') return { visible: true, run: false }
  return { visible: true, run: true }
}

/** 工具栏上的「识别文字」图标：取景框 + 三行字（两处预览共用一颗，避免画得不一样） */
export function ImageOcrIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8" />
      <path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8" />
      <path d="M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16" />
      <path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" />
      <path d="M7.5 9h9M7.5 12.5h9M7.5 16h5.5" />
    </svg>
  )
}

/** 图片的显示尺寸（`naturalWidth/Height`）：只用来校验 EXIF 方向，不参与定位计算 */
export interface ImageOcrNatural {
  width: number
  height: number
}

/**
 * 文本框能不能摆到图上：返回可用的框 + 坐标系尺寸，`null` = 摆不出位置（退回纯文本面板）。
 *
 * 比例定位只用 Rust 回的 `size`（= 推理时的图片像素尺寸），但浏览器的 `<img>` 会按 **EXIF 方向**
 * 旋转手机照片 —— 那时 `naturalWidth/Height` 与 OCR 的坐标系正好宽高互换，
 * 按 OCR 坐标摆出来的字会整体错位。对不上就不摆，宁可难看也不要错。
 */
export function placedBoxes(
  state: ImageOcrState,
  natural?: ImageOcrNatural | null,
): { boxes: ImageOcrBox[]; size: ImageOcrSize } | null {
  if (state.status !== 'done') return null
  const { boxes, size } = state
  if (!size || !boxes.length) return null
  if (natural && natural.width > 0 && natural.height > 0) {
    const rotated =
      Math.abs(natural.width - size.width) > 1 || Math.abs(natural.height - size.height) > 1
    if (rotated) return null
  }
  const usable = boxes.filter((box) => box.w > 0 && box.h > 0 && box.text.trim().length > 0)
  return usable.length ? { boxes: usable, size } : null
}

/**
 * 一个文本框 → 绝对定位样式。
 *
 * 全部用**百分比**（相对图片的布局盒）+ **容器查询单位**：
 * - `left/top` = 框 ÷ 原图尺寸；**沿阅读方向**（横排的宽 / 竖排的高）不钉死，用 `max-content`
 *   让 span 箱子就是「文字自己的尺寸」—— 这样 `scaleX/scaleY`（见 [`fitRatio`]）才是把**文字**
 *   而不是把「盒子」校到框长；垂直于阅读方向（横排的高 / 竖排的宽）钉成框的厚度；
 * - 图片缩放 / 平移时不用重算（文字层与图片在同一个变换锚点里）；
 * - `--ocr-line` = 框的厚度 ÷ 原图对应尺寸 × 100（横排 `cqh` / 竖排 `cqw`）。字号就取它：
 *   文字层容器的高 / 宽 = 图片的显示高 / 宽，所以乘出来的就是**这一行在屏幕上的像素厚度** ——
 *   改窗口尺寸、缩放时字号自动跟着变，一行 JS 都不用写。
 */
export function ocrRunStyle(
  box: ImageOcrBox,
  size: ImageOcrSize,
  vertical = isVertical(box),
): CSSProperties {
  const pct = (value: number, total: number) => `${(value / Math.max(total, 1)) * 100}%`
  // 字号 = 框的**厚度**：横排时是框高（cqh），竖排时是框宽（cqw）
  const thickness = vertical
    ? (box.w / Math.max(size.width, 1)) * 100
    : (box.h / Math.max(size.height, 1)) * 100
  return {
    left: pct(box.x, size.width),
    top: pct(box.y, size.height),
    // 沿阅读方向**不钉死**（交给 max-content + scaleX/Y 校准，见 fitRatio）：
    // 钉死的话 span 自己的盒子也被缩放，字反而会比框短一截
    width: vertical ? pct(box.w, size.width) : 'max-content',
    height: vertical ? 'max-content' : pct(box.h, size.height),
    // 自定义属性（不是 --font-size-* 令牌：这里的字号是几何量，不跟「设置 → 字体大小」走）
    ['--ocr-line' as string]: `${thickness}${vertical ? 'cqw' : 'cqh'}`,
  } as CSSProperties
}

/** 竖排（框高明显大于框宽）：用 vertical-rl，否则中文会被压成一条横线 */
export function isVertical(box: { w: number; h: number }): boolean {
  return box.h > box.w * 1.6
}

/**
 * 「把文字拉伸到框长」的校正系数 = 框长 ÷ 文字自身长度。
 *
 * 为什么需要：字号被钉成「框高」后，字体实际的步进宽度和图片里那行字的宽度并不一致
 * （中文字宽 ≈ 1em、拉丁字更窄，而 det 框是贴着图上真实字形测出来的），
 * 于是选中高亮会明显比文字长 / 短一截。这里只做纯视觉校正（文字本身是透明的），
 * 让高亮与拖选范围正好落在框上。量不到（jsdom / 还没布局）就返回 1 = 不校正。
 */
export function fitRatio(boxLength: number, textLength: number): number {
  if (!(boxLength > 0) || !(textLength > 0)) return 1
  const ratio = boxLength / textLength
  if (!Number.isFinite(ratio)) return 1
  // 量测抖动（亚像素 / 字体未就绪）不该把字压成一条线
  return Math.min(4, Math.max(0.25, Math.round(ratio * 10000) / 10000))
}

/**
 * 一行文字：按 OCR 框定位，再把文字沿长度方向拉伸 / 压缩到框长。
 *
 * 量的是**布局尺寸**（`offsetWidth/offsetHeight`），不是 getBoundingClientRect ——
 * 后者会把祖先的缩放 / 旋转算进去，而比例本身与缩放无关（目标与文字同比例变），
 * 所以只在挂载 / 换图时量一次就够，缩放时不需要重算。
 */
function OcrRun({ box, size }: { box: ImageOcrBox; size: ImageOcrSize }) {
  const ref = useRef<HTMLSpanElement>(null)
  const vertical = isVertical(box)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const plane = el.parentElement
      if (!plane) return
      const name = vertical ? '--ocr-fit-y' : '--ocr-fit'
      // 目标长度 = 框长换算成屏幕像素（图片层的布局尺寸 × 框占比）；
      // 文字长度 = span 自己的 max-content 尺寸（不含 transform，也不含祖先缩放）
      const target = vertical
        ? (plane.clientHeight * box.h) / Math.max(size.height, 1)
        : (plane.clientWidth * box.w) / Math.max(size.width, 1)
      const ratio = fitRatio(target, vertical ? el.offsetHeight : el.offsetWidth)
      if (ratio === 1) el.style.removeProperty(name)
      else el.style.setProperty(name, String(ratio))
    }

    measure()
    // 字号是 cqh/cqw（跟图片显示尺寸走）—— 窗口 / 面板一变，字号就变，校正系数要重算。
    // 观察 span 自己而不是图片：transform 不改变布局尺寸，所以不会自己触发自己。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [box.text, box.w, box.h, size.width, size.height, vertical])

  return (
    <span
      ref={ref}
      className={`image-ocr-run${vertical ? ' is-vertical' : ''}`}
      style={ocrRunStyle(box, size)}
      // 复制时要按几何拼分隔符（同行补空格 / 跟行补几个换行），见 lineSeparator
      data-ocr-box={`${box.x},${box.y},${box.w},${box.h}`}>
      {box.text}
    </span>
  )
}

/** 一行文字在复制时要用的几何量（原图像素，与 `OcrBox` 同一套坐标） */
type LineGeom = { x: number; y: number; w: number; h: number }

/** 行上携带原始框坐标（与 `OcrRun` 的 `data-ocr-box` 对应）：百分比定位是给 CSS 的，比几何得回到原图坐标系 */
const OCR_BOX_ATTR = 'data-ocr-box'

/** 两行算「同一行」的重叠阈值：竖直（竖排则水平）重叠 > 75% 就是同一行 */
const SAME_LINE_OVERLAP = 0.75
/** 不同行之间最多空几行：图里的大空白不该烂成二十个换行 */
const MAX_BLANK_LINES = 3

/** 从一行上读回框坐标（拿不到就不做几何判断，退回「一行一个换行」） */
function boxOf(run: HTMLElement): LineGeom | null {
  const raw = run.getAttribute(OCR_BOX_ATTR)
  if (!raw) return null
  const [x, y, w, h] = raw.split(',').map(Number)
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return null
  return { x, y, w, h }
}

/** 两行在「垂直于阅读方向」的轴上的重叠比例（横排看竖直、竖排看水平） */
function overlapRatio(a: LineGeom, b: LineGeom, vertical: boolean): number {
  const [startA, sizeA, startB, sizeB] = vertical ? [a.x, a.w, b.x, b.w] : [a.y, a.h, b.y, b.h]
  const overlap = Math.min(startA + sizeA, startB + sizeB) - Math.max(startA, startB)
  if (overlap <= 0) return 0
  return overlap / Math.max(Math.min(sizeA, sizeB), 1)
}

/**
 * 两行之间的分隔符（复制文本时用）—— 按**框的几何**判，不靠 DOM 顺序猜：
 *
 * - **同一行**（竖直重叠 > 75%）→ 一个空格：det 把一行切成两个框、表格同一行的相邻单元格，
 *   拼回去应该是「Name Age」而不是两行；
 * - **不同行** → 至少一个 `\n`，再看两行之间空了多少（`间隙 ÷ 行厚`）补几个 ——
 *   段落间距 / 表格行距才会粘在一起；最多补 `MAX_BLANK_LINES` 个（图里的大空白不该烂成一片空行）；
 * - 竖排（两框都是高远大于宽）把两个轴对调：同列上下两个框算同一行，并排的两列算两行。
 */
export function lineSeparator(a: LineGeom, b: LineGeom): string {
  const vertical = isVertical(a) && isVertical(b)
  if (overlapRatio(a, b, vertical) > SAME_LINE_OVERLAP) return ' '
  // 行间空隙：阅读方向上的距离（竖排是横向，且 vertical-rl 可能是从右往左，所以两边都算）
  const gap = vertical
    ? Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))
    : Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))
  const thickness = vertical ? (a.w + b.w) / 2 : (a.h + b.h) / 2
  const blank = Math.min(
    MAX_BLANK_LINES,
    Math.max(0, Math.round(gap / Math.max(thickness, 1))),
  )
  return '\n'.repeat(1 + blank)
}

/**
 * `Range.compareBoundaryPoints` 的比较方式。用数字而不是 `Range.*` 静态常量：
 * 那些常量在各实现上的暴露位置不一致，数字是规范里固定下来的（0/1/2/3）。
 */
const CMP = { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2, END_TO_START: 3 } as const

/** 选区与某一行的交集文本（没有交集返回空串）：行内从中间拖也只取真正选中的那一段 */
function overlapText(range: Range, node: HTMLElement): string {
  const doc = node.ownerDocument
  const line = doc.createRange()
  line.selectNodeContents(node)
  // 选区整段在这一行之后（range.start > line.end）/ 之前（range.end < line.start）：没有交集
  if (range.compareBoundaryPoints(CMP.END_TO_START, line) > 0) return ''
  if (range.compareBoundaryPoints(CMP.START_TO_END, line) < 0) return ''
  // 交集 = 「靠后的起点」到「靠前的终点」
  const merged = doc.createRange()
  if (range.compareBoundaryPoints(CMP.START_TO_START, line) <= 0) {
    merged.setStart(line.startContainer, line.startOffset)
  } else {
    merged.setStart(range.startContainer, range.startOffset)
  }
  if (range.compareBoundaryPoints(CMP.END_TO_END, line) >= 0) {
    merged.setEnd(line.endContainer, line.endOffset)
  } else {
    merged.setEnd(range.endContainer, range.endOffset)
  }
  return merged.toString()
}

/**
 * 选区对应的「多行文本」：按框的几何拼 —— 同一行的框之间一个空格，不同行之间按拉开的高度
 * 补 1..`MAX_BLANK_LINES+1` 个换行（见 [`lineSeparator`]）。
 *
 * 为什么不能靠浏览器：每一行都是独立的绝对定位 `<span>`（为了摆到图上原位），
 * 浏览器把这种跨元素的选区序列化成纯文本时**不会补换行** —— 选了两行，粘出来挤成一行。
 * 选区不在文字层里（例如在小条上选字）就返回空串，调用方原样交给浏览器。
 */
export function selectedLinesText(layer: HTMLElement | null): string {
  if (!layer) return ''
  const selection = layer.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const range = selection.getRangeAt(0)
  const inside = (node: Node | null) => !!node && (node === layer || layer.contains(node))
  // 选区有一端落在层外：别抢，交还浏览器（否则会复制出半截）
  if (!inside(range.startContainer) || !inside(range.endContainer)) return ''

  // 退路面板（纯文本）：浏览器选区本身就是答案，不必逐行拼
  if (!layer.querySelector('.image-ocr-run')) return selection.toString().trim()

  const parts: { text: string; box: LineGeom | null }[] = []
  for (const run of Array.from(layer.querySelectorAll<HTMLElement>('.image-ocr-run'))) {
    const text = overlapText(range, run).trim()
    if (text) parts.push({ text, box: boxOf(run) })
  }

  let out = ''
  parts.forEach((part, index) => {
    const prev = parts[index - 1]
    if (!prev) {
      out = part.text
      return
    }
    // 读不到坐标（手搓的 DOM / 旧结构）就退回「一行一个换行」
    const sep = prev.box && part.box ? lineSeparator(prev.box, part.box) : '\n'
    out += sep + part.text
  })
  return out
}

/**
 * 让「跨行拖选」复制出来是**多行**（见 [`selectedLinesText`]）。
 *
 * 监听挂在 `document` 而不是本层：`copy` 事件打在**焦点元素 / body** 上，不保证落在文字层里。
 */
function useCopyAsLines(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const text = selectedLinesText(ref.current)
      // 选区不在文字层里 / 拿不到剪贴板：原样交给浏览器的默认复制
      if (!text || !event.clipboardData) return
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [ref])
}

/**
 * 右键菜单里的「复制 / 全选」：两处预览共用（定位层与退路面板都适用）。
 *
 * 为什么要把选区**快照**传进来：点菜单项时的 `mousedown` 多半已经把网页选区折叠了，
 * 到那时候现取只能拿到空串。所以调用方在**开菜单那一刻**把 `selection` 拓下来，
 * 运行时先试活选区、拿不到再退回快照（见 `textMenuItems` 的 `getSelected`）。
 */
export function ocrTextMenuItems(opts: {
  /** 整层文字：没有选区时复制它 */
  text: string
  /** 文字层的根（`.image-ocr-layer`，或退路面板的 `.image-ocr-panel-text`） */
  root?: HTMLElement | null
  /** 开菜单那一刻选中的文字（可能是某一行的一半 / 好几行） */
  selection?: string
  /** 全选：选中整层文字（复制仍走同一条按行拼的路） */
  onSelectAll?: () => void
}): ContextMenuItem[] {
  return textMenuItems(() => opts.text, {
    selectAll: opts.onSelectAll,
    getSelected: () => selectedLinesText(opts.root ?? null) || opts.selection || '',
  })
}

/** 全选文字层（右键菜单的「全选」）：整层选中后，复制仍按行补空格 / 换行 */
export function selectAllOcrText(root: HTMLElement | null): void {
  if (!root) return
  const doc = root.ownerDocument
  const range = doc.createRange()
  range.selectNodeContents(root)
  const selection = doc.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 状态提示：识别中 / 没读出字 / 失败各一条，没读出字与失败多一颗「重新识别」
 *  `busy` = 正在跑（前面加一颗转圈：「点了没反应」就是这里没给足反馈） */
function StatusChip({
  text,
  error,
  title,
  busy,
  onRetry,
}: {
  text: string
  error?: boolean
  title?: string
  busy?: boolean
  onRetry?: () => void
}) {
  return (
    <div className={`image-ocr-status${error ? ' is-error' : ''}`} title={title}>
      {busy && <span className="image-ocr-spinner" aria-hidden="true" />}
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="image-ocr-retry" onClick={onRetry}>
          {t('重新识别')}
        </button>
      )}
    </div>
  )
}

interface PlaneProps {
  state: ImageOcrState
  /** 文字层是否展开（开关按在工具栏上） */
  visible: boolean
  /** 图片的 `naturalWidth/Height`（拿不到就不传：EXIF 校验会跳过） */
  natural?: ImageOcrNatural | null
}

/**
 * 透明定位层本体：**必须挂在图片的变换锚点里**（与 `<img>` 同级），
 * 这样图片平移 / 旋转 / 缩放时文字自动跟着走。
 */
export default function ImageOcrPlane({ state, visible, natural }: PlaneProps) {
  if (state.status !== 'done' || !visible) return null
  if (!state.text.trim()) return null

  const placed = placedBoxes(state, natural)
  if (!placed) {
    // 摆不出位置（老缓存没有框 / EXIF 方向不一致）：退回一块能复制的纯文本面板
    return (
      <div
        className="image-ocr-panel"
        onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
        onClick={(event: ReactMouseEvent) => event.stopPropagation()}>
        <div className="image-ocr-panel-text">{state.text}</div>
      </div>
    )
  }

  return <OcrLayer boxes={placed.boxes} size={placed.size} />
}

/** 定位层本体：把每一行摆到原位，并接管「跨行拖选复制」的换行（见 `useCopyAsLines`） */
function OcrLayer({ boxes, size }: { boxes: ImageOcrBox[]; size: ImageOcrSize }) {
  const ref = useRef<HTMLDivElement>(null)
  useCopyAsLines(ref)
  return (
    <div
      ref={ref}
      className="image-ocr-layer"
      // 容器上的 mousedown / click 会启动图片拖动 / 关闭浮层；文字层要自己吃下来（只到这一层）
      onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
      onClick={(event: ReactMouseEvent) => event.stopPropagation()}>
      {boxes.map((box, index) => (
        <OcrRun key={`${box.x}:${box.y}:${index}`} box={box} size={size} />
      ))}
    </div>
  )
}

interface OverlayProps extends PlaneProps {
  /** 重新识别（绕过缓存重算）：状态提示与底部小条都走它 */
  onRetry?: () => void
}

/**
 * 压在图片外面的那几块 UI：状态提示 + 底部小条（复制全部 / 重新识别）。
 *
 * 它**不能**和定位层放在同一个节点里：定位层在变换锚点内（会跟着图片旋转缩放），
 * 而小条要始终正着、压在容器下沿 —— 所以两者分开导出，由两处预览各自摆位。
 */
export function ImageOcrOverlay({ state, visible, natural, onRetry }: OverlayProps) {
  if (state.status === 'loading') {
    return <StatusChip text={t('正在识别文字…')} busy />
  }
  if (state.status === 'error') {
    return (
      <StatusChip text={t('文字识别失败')} error title={state.message} onRetry={onRetry} />
    )
  }
  if (state.status !== 'done') return null
  if (!state.text.trim()) {
    // 「识别过了，只是没读出字」也要说一声，并给一条重试的路 —— 引擎瞬时失败也长这样
    return <StatusChip text={t('未识别到文字')} onRetry={onRetry} />
  }
  if (!visible) return null

  const placed = placedBoxes(state, natural)
  return (
    <div
      className="image-ocr-bar"
      onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
      onClick={(event: ReactMouseEvent) => event.stopPropagation()}>
      <span className="image-ocr-bar-hint">
        {placed ? t('已在图上定位文字，可直接选中复制') : t('文字位置不可用，已退回纯文本')}
      </span>
      <button
        type="button"
        className="image-ocr-copy"
        onClick={() => {
          void copyText(state.text).then((ok) => {
            if (ok) showToast(t('已复制到剪贴板'))
          })
        }}>
        {t('复制全部文字')}
      </button>
      {onRetry && (
        <button type="button" className="image-ocr-retry" onClick={onRetry}>
          {t('重新识别')}
        </button>
      )}
    </div>
  )
}
