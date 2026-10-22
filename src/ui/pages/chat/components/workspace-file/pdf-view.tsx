/**
 * PdfView — PDF 预览：**前端按页栅格化**（pdfjs-dist）。
 *
 * 为什么渲染在这一层而不是 Core：Core 只做纯 Rust 的 PDF **文字**抽取
 * （`doc_parse::pdf` 明确不做页面栅格化 —— 那要引入 PDF 渲染器这种原生库）。
 * 面板要的是「看起来像那一页」，所以这里交给 pdfjs 画。
 *
 * 五条口径：
 * 1. **懒加载模块**：pdfjs 只在真的打开 PDF 时才 `import()` —— 其它文件（以及 jsdom 用例）
 *    不为它付任何代价；
 * 2. **按页懒渲染**：滚到附近的页才画（`IntersectionObserver`，提前 600px），
 *    几百页的文档不会在打开瞬间占满主线程与内存；
 * 3. **高分屏不糊**：画布按 `devicePixelRatio` 放大（上限 2），CSS 尺寸仍用逻辑像素；
 * 4. **缩放只有「适应宽度」与手动百分比**：改缩放会取消进行中的渲染任务，
 *    否则旧任务会把新画布覆盖掉（pdfjs 的 `RenderTask.cancel` 就是为这个存在的）；
 * 5. **cMaps / 标准字体随包分发**：中文 PDF 里没嵌字体的文本要靠 cMaps 映射到字形，
 *    缺了会整段空白 —— 见 `vite.config.ts` 里 `pdfjsAssets` 插件（`/pdfjs/cmaps/`）。
 */
import { useEffect, useRef, useState } from 'react'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist'
import { t, tpl } from '@/ui/i18n'
import LoadingIcon from './loading-icon'

interface Props {
  /** PDF 原始字节（调用方已读过安全校验；这里会**拷贝**一份交给 pdfjs，见下） */
  bytes: Uint8Array
  /** 文件名（无障碍标签） */
  name: string
  onOpenInSystem: () => void
}

/** 缩放范围：再小看不清，再大画布内存会炸 */
const MIN_ZOOM = 0.3
const MAX_ZOOM = 4

/** 「适应宽度」要减去的左右留白（与 `.wfp-pdf-scroll` 的 padding 同值） */
const H_PADDING = 24

/** 老 WebView2 缺 `Promise.withResolvers`（Chrome 119+ 才有）：pdfjs 4.x 会用到 */
function installPromiseWithResolvers(): void {
  const ctor = Promise as unknown as { withResolvers?: () => unknown }
  if (typeof ctor.withResolvers === 'function') return
  ctor.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// 模块体在 `import()` 之前执行：补丁必须先于 pdfjs 的代码跑起来
installPromiseWithResolvers()

interface PageSize {
  width: number
  height: number
}

/** 单页：滚到附近才画 */
function PdfPage({
  doc,
  index,
  scale,
  fallback,
}: {
  doc: PDFDocumentProxy
  index: number
  scale: number
  fallback: PageSize | null
}) {
  const holderRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 是否已经滚到附近（一旦为真就不再退回：回去时保留已画好的画布） */
  const [near, setNear] = useState(false)
  /** 这一页自己的尺寸（首页尺寸只用来占位，横向页 / A3 页要按自己的来） */
  const [size, setSize] = useState<PageSize | null>(null)

  useEffect(() => {
    const holder = holderRef.current
    if (!holder || near) return
    // jsdom 没有 IntersectionObserver：直接画（用例里也不需要懒加载）
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(holder)
    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    if (!near) return
    let cancelled = false
    let task: RenderTask | null = null
    let page: PDFPageProxy | null = null
    void (async () => {
      page = await doc.getPage(index + 1)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      setSize({ width: viewport.width, height: viewport.height })
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (!canvas || !context) return
      // 高分屏：画布放大、CSS 尺寸不变（否则字会糊成一团）
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      task = page.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      })
      await task.promise
    })().catch(() => {
      // 取消（换缩放 / 关闭面板）与真正的渲染失败都落这里：保留占位框，不打断阅读
    })
    return () => {
      cancelled = true
      task?.cancel()
      try {
        page?.cleanup()
      } catch {
        // 正在渲染时 cleanup 可能被库拒绝：下一次进可见区会重新取页，不影响结果
      }
    }
  }, [near, doc, index, scale])

  // 没画之前先用首页尺寸占位：滚动条长度一开始就是对的，不会「越滚越长」
  const box = size ?? (fallback ? { width: fallback.width * scale, height: fallback.height * scale } : null)

  return (
    <div
      ref={holderRef}
      className="wfp-pdf-page"
      style={box ? { width: Math.floor(box.width), height: Math.floor(box.height) } : undefined}>
      <canvas ref={canvasRef} className="wfp-pdf-canvas" />
    </div>
  )
}

export default function PdfView({ bytes, name, onOpenInSystem }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  /** 首页尺寸（占位 + 算「适应宽度」） */
  const [pageSize, setPageSize] = useState<PageSize | null>(null)
  /** `null` = 适应宽度；数字 = 用户手动定的缩放倍数 */
  const [zoom, setZoom] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let loading: PDFDocumentLoadingTask | null = null
    setDoc(null)
    setError('')
    setPageSize(null)
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        loading = pdfjs.getDocument({
          // pdfjs 会把 buffer **转移**给 worker：这里给一份拷贝，
          // 否则重复挂载 / 重新加载会拿到一个已分离的 ArrayBuffer（报 detached）
          data: new Uint8Array(bytes),
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          // 文档内容不该被当成脚本执行（webview 的 CSP 是 null，库里有开关就用它）
          isEvalSupported: false,
        })
        const loaded = await loading.promise
        if (cancelled) return
        const viewport = (await loaded.getPage(1)).getViewport({ scale: 1 })
        if (cancelled) return
        setPageSize({ width: viewport.width, height: viewport.height })
        setDoc(loaded)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      void loading?.destroy()
    }
  }, [bytes])

  // 「适应宽度」要跟着面板宽度变（右侧面板可拖宽）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [doc])

  const fitScale =
    pageSize && width > 0
      ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (width - H_PADDING) / pageSize.width))
      : 1
  const scale = zoom ?? fitScale
  const percent = Math.round(scale * 100)

  if (error) {
    return (
      <div className="wfp-hint is-error">
        <p>{t('这份 PDF 无法渲染')}</p>
        <p className="wfp-hint-detail">{error}</p>
        <button type="button" className="wfp-action" onClick={onOpenInSystem}>
          {t('在系统程序中打开')}
        </button>
      </div>
    )
  }
  // 未打开完成：转圈 + 一句话（与面板其它读取中状态同一个视觉）
  if (!doc) {
    return (
      <div className="wfp-hint">
        <LoadingIcon />
        <p>{t('正在读取文件…')}</p>
      </div>
    )
  }

  return (
    <div className="wfp-pdf">
      <div className="wfp-pdf-bar">
        <span className="wfp-pdf-count">{tpl('共 $__pages__ 页', { pages: doc.numPages })}</span>
        <span className="wfp-spacer" />
        <button
          type="button"
          className="wfp-icon-btn"
          title={t('缩小')}
          aria-label={t('缩小')}
          onClick={() => setZoom(Math.max(MIN_ZOOM, Math.round((scale - 0.1) * 100) / 100))}>
          −
        </button>
        <button
          type="button"
          className={`wfp-pdf-percent${zoom === null ? ' is-fit' : ''}`}
          title={t('适应宽度')}
          onClick={() => setZoom(null)}>
          {percent}%
        </button>
        <button
          type="button"
          className="wfp-icon-btn"
          title={t('放大')}
          aria-label={t('放大')}
          onClick={() => setZoom(Math.min(MAX_ZOOM, Math.round((scale + 0.1) * 100) / 100))}>
          +
        </button>
      </div>
      <div className="wfp-pdf-scroll" ref={scrollRef} aria-label={name}>
        {Array.from({ length: doc.numPages }, (_, index) => (
          <PdfPage key={index} doc={doc} index={index} scale={scale} fallback={pageSize} />
        ))}
      </div>
    </div>
  )
}
