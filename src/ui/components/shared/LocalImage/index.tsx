/**
 * LocalImage —— Markdown 正文里的图片。
 *
 * 与直接写 `<img>` 的差别只有一件事：**本地路径也要能显示**。
 * AI 常返回 `![](./screenshots/a.png)`、`![](C:\code\a.png)` 这类地址，webview 拿它们当 `src`
 * 只得到一片空白（`file:` 加载不了；相对路径相对的是页面，不是工作目录）。
 * 这里按 `parseImageSrc` 分两路：远程 / data / blob 原样渲染，本地路径读盘转 blob URL 再渲染。
 *
 * 交互与消息气泡里发出去的图对齐：点击放大、右键「复制图片 / 另存为 / 在文件管理器中显示 / 复制路径」。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { t } from '@/ui/i18n'
import { chatState } from '@/ui/store'
import { parseImageSrc, type ParsedImageSrc } from '@/domain/files/image-src'
import {
  loadLocalImage,
  LocalImageError,
  peekCachedImage,
  type LoadedImage,
} from '@/services/local-image-service'
import { showImagePreview } from '@/ui/components/shared/ImagePreview'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { imageMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import './style.scss'

/**
 * 读盘前的等待：流式输出时 `src` 还在一个字一个字长（`![](./a.p`），
 * 等它稳定一拍再动手，省掉一串注定失败的 IPC；本地读盘本身是毫秒级，这点延迟感知不到。
 */
const LOAD_DELAY_MS = 80

type LocalState =
  | { status: 'loading' }
  | { status: 'ready'; image: LoadedImage }
  | { status: 'failed'; reason: string }

/** 右键目标：远程图没有本地信息，菜单里就只有「复制图片 / 另存为」 */
interface MenuTarget {
  url: string
  image: LoadedImage | null
}

interface Props {
  src?: string
  alt?: string
  title?: string
}

/** 首帧就把缓存里的图拿出来：流式「前缀冻结」会把同一张图搬到另一棵树上（= 重新挂载） */
function initialLocalState(parsed: ParsedImageSrc, sessionId?: string): LocalState {
  const cached = peekCachedImage(parsed.value, sessionId)
  return cached ? { status: 'ready', image: cached } : { status: 'loading' }
}

function reasonOf(error: unknown): string {
  if (error instanceof LocalImageError) {
    if (error.code === 'not-image') return t('不是图片文件')
    if (error.code === 'too-large') return t('图片过大')
    if (error.code === 'not-found') return t('文件不存在')
    if (error.code === 'not-file') return t('不是文件')
  }
  return error instanceof Error ? error.message : String(error)
}

function BrokenImageSvg() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.3" />
      <path d="M21 16l-5-5L5 20" />
    </svg>
  )
}

/** 加载不出来时的窄条：给出**原因 + 原始地址**，别只留一片空白让人猜 */
function FailedNote({ reason, raw }: { reason: string; raw: string }) {
  return (
    <span className="md-image-failed" title={raw ? `${reason}\n${raw}` : reason}>
      <BrokenImageSvg />
      <span className="md-image-failed-text">{reason}</span>
      {raw && <code className="md-image-failed-src">{raw}</code>}
    </span>
  )
}

export default function LocalImage({ src, alt, title }: Props) {
  const parsed = useMemo(() => parseImageSrc(src ?? ''), [src])
  const sessionId = chatState.value.currentSessionId ?? undefined
  const menu = useContextMenu<MenuTarget>()

  const [state, setState] = useState<LocalState>(() =>
    parsed.kind === 'inline' ? { status: 'loading' } : initialLocalState(parsed, sessionId),
  )
  /**
   * `state` 属于哪个 `src`。
   * src 换了但 effect 还没跑的那一帧不能拿上一张图充数（流式里 `![](a.p` → `![](a.png)`
   * 很常见），否则会先闪一下旧图。
   */
  const [stateFor, setStateFor] = useState(parsed.value)
  /** 远程 / data 图加载失败（本地图有自己的 state.failed） */
  const [inlineFailed, setInlineFailed] = useState(false)

  const current: LocalState = stateFor === parsed.value ? state : { status: 'loading' }
  const update = (next: LocalState) => {
    setState(next)
    setStateFor(parsed.value)
  }

  useEffect(() => {
    setInlineFailed(false)
    if (parsed.kind === 'inline') return

    if (!parsed.value) {
      update({ status: 'failed', reason: t('图片地址为空') })
      return
    }

    const cached = peekCachedImage(parsed.value, sessionId)
    if (cached) {
      update({ status: 'ready', image: cached })
      return
    }

    let alive = true
    update({ status: 'loading' })
    const timer = setTimeout(() => {
      loadLocalImage(parsed.value, sessionId)
        .then((image) => {
          if (alive) update({ status: 'ready', image })
        })
        .catch((error) => {
          if (alive) update({ status: 'failed', reason: reasonOf(error) })
        })
    }, LOAD_DELAY_MS)

    return () => {
      alive = false
      clearTimeout(timer)
    }
    // update 每次渲染都是新函数，故意不进依赖（它只是把当前 src 和状态绑在一起）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.kind, parsed.value, sessionId])

  function menuItemsOf(target: MenuTarget): ContextMenuItem[] {
    const items = imageMenuItems(
      target.url,
      target.image
        ? {
            mime: target.image.mime,
            // 另存为的默认名是 `<前缀>-20261013-...`，后缀交给保存对话框
            namePrefix: target.image.name.replace(/\.[^.]+$/, ''),
          }
        : {},
    )
    if (!target.image) return items

    const absolutePath = target.image.absolutePath
    return [
      ...items,
      {
        key: 'reveal',
        label: t('在文件管理器中显示'),
        divider: true,
        onClick: () => {
          revealItemInDir(absolutePath).catch(() => showToast(t('打开失败')))
        },
      },
      {
        key: 'copy-path',
        label: t('复制路径'),
        onClick: async () => {
          const ok = await copyText(absolutePath)
          showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
        },
      },
    ]
  }

  let body: ReactNode
  if (parsed.kind === 'inline') {
    body = inlineFailed ? (
      <FailedNote reason={t('图片无法加载')} raw={parsed.raw} />
    ) : (
      <img
        className="md-image"
        src={parsed.value}
        alt={alt ?? ''}
        title={title || undefined}
        loading="lazy"
        decoding="async"
        onError={() => setInlineFailed(true)}
        onClick={(event) => {
          // 图片常被包在链接里（`[![alt](a.png)](url)`）：放大看，别顺手把链接也打开
          event.preventDefault()
          event.stopPropagation()
          showImagePreview({ src: parsed.value })
        }}
        onContextMenu={(event) => menu.openAt(event, { url: parsed.value, image: null })}
      />
    )
  } else if (current.status === 'loading') {
    body = <span className="md-image-loading" role="img" aria-label={t('加载中')} />
  } else if (current.status === 'failed') {
    body = <FailedNote reason={current.reason} raw={parsed.raw} />
  } else {
    const { image } = current
    body = (
      <img
        className="md-image"
        src={image.url}
        alt={alt ?? ''}
        title={title || undefined}
        loading="lazy"
        decoding="async"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          showImagePreview({ src: image.url })
        }}
        onContextMenu={(event) => menu.openAt(event, { url: image.url, image })}
      />
    )
  }

  return (
    <>
      {body}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={menuItemsOf(menu.state.target)}
          onClose={menu.close}
        />
      )}
    </>
  )
}
