/**
 * ImageViewer — 图片预览（工作目录面板内）：**滚轮绕指针缩放、按住拖动平移**、工具栏与右键菜单。
 *
 * 五条口径：
 * 1. **滚轮只缩放，不滚外层**：图片区没有可滚动的内容（缩放由 transform 完成），
 *    滚轮滚走面板只会让人以为图「丢了」；监听必须 `passive: false` 才能拦住默认滚动。
 * 2. **变换只发生在 CSS**：`translate → rotate → scale` 之后，图片的布局尺寸仍是「适应窗口」的
 *    那份，所以容器不会出现滚动条、面板也不会跟着抖。
 * 3. **平移夹边**：放大后的图不能被拖出视口（`clampPan`），旋转 90° 时宽高互换也要算进去。
 * 4. **旋转只影响查看**：它不改图片字节、也不产生「未保存」——用户要转的是「看」，不是「存」。
 * 5. **右键菜单与消息里的图片同源**：复制图片 / 另存为复用 `imageMenuItems`，只在本文件追加
 *    旋转与视图动作（blob URL 没有扩展名，所以把 `mime` 一并传下去）；
 *    文字层里右键换成「复制 / 全选」（`ocrTextMenuItems`）—— 本窗口全局屏蔽了系统右键菜单，
 *    让给系统等于什么都没有。
 * 6. **识别文字默认不跑也不显示**：设置 → 「图片预览自动识别文字」打开时，打开预览就跑一次 OCR；
 *    否则点工具栏「识别文字」才识别（只做 OCR，不做视觉识别）。结果以**透明定位层**摆在图片上的
 *    原位置（可直接选中复制），默认收起，识别逻辑在 `hooks/useImageOcr` + `shared/ImageOcr`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { imageMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import ImageOcrPlane, {
  canOcr,
  ImageOcrIcon,
  ImageOcrOverlay,
  nextOcrAction,
  ocrButtonTitle,
  ocrTextMenuItems,
  selectAllOcrText,
  selectedLinesText,
} from '@/ui/components/shared/ImageOcr'
import { useImageOcr } from '@/ui/hooks/useImageOcr'
import {
  actualSizeScale,
  clampPan,
  fitRatio,
  IDENTITY_VIEW,
  IMAGE_MIN_SCALE,
  rotateView,
  scalePercent,
  stepScale,
  zoomAt,
  type ImageView,
} from '@/domain/files/image-view'

interface Props {
  /** 图片地址（面板里是 blob URL） */
  src: string
  /** 文件名：`alt`、另存为的默认名前缀 */
  name: string
  /** MIME：blob URL 没有扩展名，另存为 / 剪贴板要靠它 */
  mime: string
  /**
   * 本地绝对路径：**预览时的 OCR 走它**（Rust 直接读文件，不必把整张图 base64 传一遍）。
   * 没有路径（如 SVG 预览）就不识别文字。
   */
  path?: string
  /** 「在系统程序中打开」（面板已有实现，这里只透传） */
  onOpenInSystem: () => void
}

/** 绕容器中心缩放（工具栏按钮与「重置」都用它） */
const CENTER = { x: 0, y: 0 }

/** 单向旋转图标（`flip` = 逆时针）；与 `ImagePreview` 里那颗同一造型，避免两处画得不一样 */
function RotateSvg({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path
        d="M15.55 5.55 11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42 1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.48z"
        fill="currentColor"
      />
    </svg>
  )
}

export default function ImageViewer({ src, name, mime, path, onOpenInSystem }: Props) {
  const [view, setView] = useState<ImageView>(IDENTITY_VIEW)
  const [dragging, setDragging] = useState(false)
  /** 图片自然尺寸与容器可视区：只用于算「100% 是多少真实像素」 */
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState({ width: 0, height: 0 })

  // 识别文字（**只做 OCR**）：开关由设置 `imageOcrAutoPreview` 决定，关着就等用户点按钮
  const ocr = useImageOcr(path ? { src, path } : null)
  /** 文字层**默认收起**；换图时回到收起 */
  const [ocrVisible, setOcrVisible] = useState(false)
  useEffect(() => {
    setOcrVisible(false)
  }, [src, path])

  /** 工具栏「识别文字」：有字就收起/展开，没跑过就跑一次 */
  const handleOcrClick = () => {
    const next = nextOcrAction(ocr.state, ocrVisible)
    setOcrVisible(next.visible)
    if (next.run) ocr.start()
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  /** 当前视图（事件回调里读最新值，避免闭包滞后一帧） */
  const viewRef = useRef<ImageView>(IDENTITY_VIEW)
  /** 拖动起点：按下时的指针位置减掉当时的平移量 */
  const dragStartRef = useRef({ x: 0, y: 0 })
  /**
   * 右键菜单两种宿主：图片本体（复制 / 另存为 / 旋转…）与 OCR 文字层（复制 / 全选）。
   * 文字层那种把**选区快照**一并带上：菜单项是另一处的按钮，点它时选区可能已被折叠。
   */
  const menu = useContextMenu<
    { kind: 'image' } | ({ kind: 'text' } & Parameters<typeof ocrTextMenuItems>[0])
  >()

  /** 所有视图变更的唯一出口：先夹边再落地（尺寸未知时 `clampPan` 会原样返回） */
  const commit = useCallback((next: ImageView) => {
    const container = containerRef.current
    const image = imageRef.current
    const bounded =
      container && image
        ? clampPan(
            next,
            { width: image.offsetWidth, height: image.offsetHeight },
            { width: container.clientWidth, height: container.clientHeight },
          )
        : next
    viewRef.current = bounded
    setView(bounded)
  }, [])

  // 容器尺寸：面板可拖宽，视口变化后要重新夹边（否则图会卡在旧边界外）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () =>
      setViewport({ width: container.clientWidth, height: container.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!viewport.width && !viewport.height) return
    commit(viewRef.current)
  }, [viewport, commit])

  // 滚轮缩放：必须非 passive，否则拦不住容器的默认滚动
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (event: WheelEvent) => {
      // 纯文本退路面板自己可滚动：滚它不该缩放图片
      if (event.target instanceof Element && event.target.closest('.image-ocr-panel')) return
      // 缩放只属于这张图：默认滚动挡掉，也不再冒泡给聊天列表（否则会连带滚消息）
      event.preventDefault()
      event.stopPropagation()
      const rect = container.getBoundingClientRect()
      const pointer = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      }
      const current = viewRef.current
      // deltaY < 0（向上滚）= 放大，与所有看图软件一致
      const direction = event.deltaY < 0 ? 1 : -1
      commit(zoomAt(current, pointer, stepScale(current.scale, direction)))
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [commit])

  // 拖动平移：监听挂 document，指针移出面板也不断
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: MouseEvent) => {
      const current = viewRef.current
      commit({
        ...current,
        x: event.clientX - dragStartRef.current.x,
        y: event.clientY - dragStartRef.current.y,
      })
    }
    const onUp = () => setDragging(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragging, commit])

  const startDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    // 文字层里要能选中文字：按下不能开始平移图片
    if (event.target instanceof Element && event.target.closest('.image-ocr-run, .image-ocr-panel')) return
    event.preventDefault()
    dragStartRef.current = {
      x: event.clientX - viewRef.current.x,
      y: event.clientY - viewRef.current.y,
    }
    setDragging(true)
  }

  const handleLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    setNatural({ width: image.naturalWidth, height: image.naturalHeight })
    // 换图 / 重新加载后回到「适应窗口」—— 沿用上一张的缩放会立刻看到一块糊掉的角落
    commit(IDENTITY_VIEW)
  }

  const ratio = fitRatio(natural, viewport)
  const percent = scalePercent(ratio, view.scale)

  /** 右键菜单：复制 / 另存为（与消息里的图片同一份）+ 旋转 / 视图 / 系统打开 */
  const imageItems: ContextMenuItem[] = [
    ...imageMenuItems(src, {
      namePrefix: name.replace(/\.[^./\\]+$/, ''),
      mime,
    }),
    {
      key: 'rotate-left',
      label: t('向左旋转'),
      onClick: () => commit(rotateView(viewRef.current, -90)),
    },
    {
      key: 'rotate-right',
      label: t('向右旋转'),
      onClick: () => commit(rotateView(viewRef.current, 90)),
    },
    {
      key: 'actual-size',
      label: t('实际大小'),
      divider: true,
      onClick: () => commit({ ...IDENTITY_VIEW, scale: actualSizeScale(ratio) }),
    },
    {
      key: 'fit',
      label: t('适应窗口'),
      onClick: () => commit(IDENTITY_VIEW),
    },
    {
      key: 'open-system',
      label: t('在系统程序中打开'),
      divider: true,
      onClick: onOpenInSystem,
    },
  ]

  /** 菜单项：文字层里右键 = 复制 / 全选，其余照旧是图片动作 */
  const menuItems =
    menu.state?.target.kind === 'text' ? ocrTextMenuItems(menu.state.target) : imageItems

  return (
    <div
      ref={containerRef}
      className={`wfp-image${dragging ? ' is-dragging' : ''}`}
      onMouseDown={startDrag}
      onContextMenu={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest('.image-ocr-run, .image-ocr-panel')) {
          menu.openAt(event, { kind: 'image' })
          return
        }
        // 文字层：复制 / 全选 —— 本窗口全局屏蔽了系统右键菜单，让给系统等于什么都没有
        const root = containerRef.current?.querySelector<HTMLElement>(
          '.image-ocr-layer, .image-ocr-panel-text',
        ) ?? null
        menu.openAt(event, {
          kind: 'text',
          text: ocr.state.status === 'done' ? ocr.state.text : '',
          root,
          // 开菜单这一刻的选区快照（点菜单项时选区可能已被折叠）
          selection: selectedLinesText(root),
          onSelectAll: () => selectAllOcrText(root),
        })
      }}>
      {/* 工具栏：按下不能触发拖动（否则点一下图片就跟着跑） */}
      <div className="wfp-image-bar" onMouseDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="wfp-image-btn"
          onClick={() => commit(zoomAt(view, CENTER, stepScale(view.scale, -1)))}
          disabled={view.scale <= IMAGE_MIN_SCALE}
          title={t('缩小')}
          aria-label={t('缩小')}>
          −
        </button>
        <button
          type="button"
          className="wfp-image-btn is-percent"
          onClick={() => commit(IDENTITY_VIEW)}
          title={t('适应窗口')}
          aria-label={`${percent}%`}>
          {percent}%
        </button>
        <button
          type="button"
          className="wfp-image-btn"
          onClick={() => commit(zoomAt(view, CENTER, stepScale(view.scale, 1)))}
          title={t('放大')}
          aria-label={t('放大')}>
          ＋
        </button>
        <button
          type="button"
          className="wfp-image-btn"
          onClick={() => commit(rotateView(view, -90))}
          title={t('向左旋转')}
          aria-label={t('向左旋转')}>
          <RotateSvg flip />
        </button>
        <button
          type="button"
          className="wfp-image-btn"
          onClick={() => commit(rotateView(view, 90))}
          title={t('向右旋转')}
          aria-label={t('向右旋转')}>
          <RotateSvg />
        </button>
        {canOcr(ocr.state) && (
          <button
            type="button"
            className={`wfp-image-btn ocr-btn${ocrVisible ? ' is-active' : ''}`}
            onClick={handleOcrClick}
            aria-label={ocrButtonTitle(ocr.state, ocrVisible)}
            title={ocrButtonTitle(ocr.state, ocrVisible)}>
            <ImageOcrIcon size={14} />
          </button>
        )}
      </div>

      {/* 图片 + 透明文字层的变换锚点：缩放 / 平移 / 旋转都挂在这里，字才能跟着图片一起动 */}
      <div
        className="wfp-image-anchor"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) rotate(${view.rotate}deg) scale(${view.scale})`,
        }}>
        <img
          ref={imageRef}
          src={src}
          alt={name}
          className="wfp-image-content"
          draggable={false}
          onLoad={handleLoad}
          // 原生拖拽会盖掉「按住拖动平移」，并留下一个半透明的拖影
          onDragStart={(event) => event.preventDefault()}
        />
        <ImageOcrPlane state={ocr.state} visible={ocrVisible} natural={natural} />
      </div>

      <ImageOcrOverlay
        state={ocr.state}
        visible={ocrVisible}
        natural={natural}
        onRetry={ocr.retry}
      />

      {menu.state && (
        // 与图片容器平级（portal 到 body）：菜单项点击不能被容器的拖动 / 右键处理吃掉
        <ContextMenu position={menu.state.position} items={menuItems} onClose={menu.close} />
      )}
    </div>
  )
}
