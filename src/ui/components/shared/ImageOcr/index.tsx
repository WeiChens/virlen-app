/**
 * ImageOcr —— 图片预览里的「识别文字」层。
 *
 * 口径（两处图片预览共用本组件：大图浮层 `ImagePreview` 与工作目录 `ImageViewer`）：
 * 1. **只做 OCR**：文本来自 `vision_ocr`（不做视觉识别），见 `hooks/useImageOcr`；
 * 2. **默认不显示**：文字层盖在图上，但初始是收起的（`visible = false`）—— 要看再点工具栏；
 * 3. **半透明文字层**：白字压在深色半透明底上，任何主题 / 任何图片都读得清；
 * 4. **每种状态都有话说**：识别中 / 没文字 / 失败各一条小提示 —— 静默等于「点了没反应」；
 * 5. **文字可选中可复制**：这是「看图取字」的唯一目的，层里不能被容器的拖动/缩放吃掉事件。
 */
import { t } from '@/ui/i18n'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
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

interface Props {
  state: ImageOcrState
  /** 文字层是否展开（只在 `hasOcrText` 时有意义，开关按在工具栏上） */
  visible: boolean
  /** 重新识别（绕过缓存重算）：状态提示里的「重新识别」走它 */
  onRetry?: () => void
}

/** 状态提示：识别中 / 没读出字 / 失败各一条，没读出字与失败多一颗「重新识别」 */
function StatusChip({
  text,
  error,
  title,
  onRetry,
}: {
  text: string
  error?: boolean
  title?: string
  onRetry?: () => void
}) {
  return (
    <div className={`image-ocr-status${error ? ' is-error' : ''}`} title={title}>
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="image-ocr-retry" onClick={onRetry}>
          {t('重新识别')}
        </button>
      )}
    </div>
  )
}

export default function ImageOcrLayer({ state, visible, onRetry }: Props) {
  if (state.status === 'loading') {
    return <StatusChip text={t('正在识别文字…')} />
  }
  if (state.status === 'error') {
    return (
      <StatusChip
        text={t('文字识别失败')}
        error
        title={state.message}
        onRetry={onRetry}
      />
    )
  }
  if (state.status !== 'done') return null
  if (!state.text.trim()) {
    // 「识别过了，只是没读出字」也要说一声，并给一条重试的路 —— 引擎瞬时失败也长这样
    return <StatusChip text={t('未识别到文字')} onRetry={onRetry} />
  }
  if (!visible) return null

  return (
    <div
      className="image-ocr-layer"
      // 容器上的 mousedown / click 会启动图片拖动 / 关闭浮层，文字层必须自己拦下来
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}>
      <div className="image-ocr-head">
        <span className="image-ocr-title">{t('识别文字')}</span>
        <button
          type="button"
          className="image-ocr-copy"
          onClick={() => {
            void copyText(state.text).then((ok) => {
              if (ok) showToast(t('已复制到剪贴板'))
            })
          }}>
          {t('复制文字')}
        </button>
      </div>
      <div className="image-ocr-text">{state.text}</div>
    </div>
  )
}
