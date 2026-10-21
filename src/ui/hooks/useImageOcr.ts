/**
 * useImageOcr — 图片预览的 OCR（只做 OCR，不做视觉识别）。
 *
 * 七条口径：
 * 1. **默认不识别、不显示**：打开预览只把图片显示出来 —— OCR 是秒级 CPU 密集操作，
 *    不该在用户只是「看一眼图」时自动扣掉。`auto` 为真（设置 →「图片预览自动识别文字」）时
 *    才在打开 / 切图后自动跑一次；否则等用户点工具栏的「识别文字」（`start()`）；
 * 2. **做过就不再算**：Rust 侧按**内容指纹**落盘缓存（`image-ocr-cache.json`），重启后照样命中；
 *    这里再留一层进程内 memo —— 同一张图反复开关预览不必再走一次 IPC；
 * 3. **有本地路径优先用路径**：Rust 直接读文件，不必把整张图 base64 传一遍 IPC；没有路径
 *    （消息里的 `data:` / `blob:` / 远端 URL）才转成 data URL 走 base64 命令；
 * 4. **失败不缓存、空结果也不缓存**（后者由 Rust 侧保证）：引擎瞬时失败会被 quasivision 吞成空文本，
 *    与「图里真没字」分不开 —— 所以空结果只当次有效，绝不落盘；
 * 5. **两种触发**：`start()` = 正常识别（可以命中缓存，界面按钮用）；`retry()` = 带 `force` 重算
 *    （绕开进程内 memo 与 Rust 磁盘缓存，救回被写坏的缓存）；
 * 6. **`ready` 与 `idle` 分开**：`idle` = 没有可识别的目标（未打开 / SVG，不该给按钮）；
 *    `ready` = 就绪但还没跑（设置关了自动识别，等用户点）—— 工具栏据此决定按钮要不要出现；
 * 7. **SVG 不识别**：它不是位图，OCR 必然失败，直接 `idle`（不打扰用户）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { vision } from '@/infrastructure/vision'
import type { ImageOcrResult } from '@/infrastructure/vision/types'
import { settingsState } from '@/ui/store/settingStore'
import { bytesToBase64, imageMimeOf, readImageBytes } from '@/utils/clipboard'

export type ImageOcrState =
  /** 没有要识别的图（未打开 / SVG） */
  | { status: 'idle' }
  /** 就绪，还没识别（设置关了「打开即识别」，等用户点工具栏） */
  | { status: 'ready' }
  | { status: 'loading' }
  /** 识别完成：`text` 为空串 = 这次没读出字（可能是引擎瞬时失败，界面给「重新识别」） */
  | { status: 'done'; text: string }
  | { status: 'error'; message: string }

export interface ImageOcrHandle {
  state: ImageOcrState
  /** 开始识别（不绕缓存）：设置关了自动识别时，用户点「识别文字」走它 */
  start: () => void
  /** 用户点「重新识别」：绕过进程内 memo 与 Rust 磁盘缓存重算 */
  retry: () => void
}

/** 要识别的图：有 `path` 时优先走路径，否则从 `src` 取字节 */
export interface ImageOcrTarget {
  src: string
  /** 本地绝对路径（工作目录里的文件有这个） */
  path?: string
}

export interface ImageOcrOptions {
  /**
   * 打开预览就自动识别。不传时读设置 `imageOcrAutoPreview`（默认关）；
   * 显式传值只给测试 / 特殊入口用。
   */
  auto?: boolean
}

/** 进程内 memo：键 = 路径或 src；只存成功的任务（失败的下次重试） */
const memo = new Map<string, Promise<ImageOcrResult>>()

/** 进程内 memo（测试要清；也方便排查「这次到底走了几次 IPC」） */
export const imageOcrMemo = memo

/** SVG 是矢量图，没有可识别的位图文本 */
function isSvg(target: ImageOcrTarget): boolean {
  if (/^data:image\/svg\+xml[\w.+-]*[,;]/i.test(target.src)) return true
  const path = (target.path ?? '').split('?')[0].toLowerCase()
  return path.endsWith('.svg')
}

/** 任意图片地址 → data URL（`data:` 原样返回；`blob:` / 远端读字节，远端走 plugin-http 绕开 CORS） */
async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src
  const bytes = await readImageBytes(src)
  return `data:${imageMimeOf(src)};base64,${bytesToBase64(bytes)}`
}

function runOcr(target: ImageOcrTarget, force: boolean): Promise<ImageOcrResult> {
  if (target.path) return vision.ocr(target.path, force)
  return toDataUrl(target.src).then((dataUrl) =>
    vision.ocrBase64(dataUrl, force),
  )
}

export function useImageOcr(
  target: ImageOcrTarget | null,
  options: ImageOcrOptions = {},
): ImageOcrHandle {
  const src = target?.src ?? ''
  const path = target?.path
  const enabled = target !== null && !isSvg({ src, path })
  const key = enabled ? (path ?? src) : ''

  const auto = options.auto ?? settingsState.value.imageOcrAutoPreview

  const [state, setState] = useState<ImageOcrState>({ status: 'idle' })
  /** 自增即触发重跑（`start` / `retry` 用） */
  const [attempt, setAttempt] = useState(0)
  /** 用户手动点过「识别文字」的图（键 = 路径或 src）；换图后自然失配，回到跟随设置 */
  const [startedKey, setStartedKey] = useState('')
  /** 下一次 effect 是否绕过缓存 —— 只在 retry 后的那一轮为 true */
  const forceRef = useRef(false)

  /** 该不该跑：设置允许自动，或用户点过这张图 */
  const wanted = key !== '' && (auto || startedKey === key)

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' })
      return
    }
    if (!wanted) {
      // 已经识别完的就留着（用户中途关掉「自动识别」不该把结果收走）
      setState((prev) => (prev.status === 'done' ? prev : { status: 'ready' }))
      return
    }
    const force = forceRef.current
    forceRef.current = false

    let cancelled = false
    setState({ status: 'loading' })

    let task = force ? undefined : memo.get(key)
    if (!task) {
      task = runOcr({ src, path }, force)
      if (!force) {
        memo.set(key, task)
        // 失败 / 空结果的从 memo 里摘掉：下次打开（模型装好了 / 图片又能读了）应该重新试
        task.then(
          (result) => {
            if (!result?.text?.trim() && memo.get(key) === task) memo.delete(key)
          },
          () => {
            if (memo.get(key) === task) memo.delete(key)
          },
        )
      }
    }
    task.then(
      (result) => {
        // `?? ''`：命令返回体意外为空时宁可显示「未识别到文字」，也不要把预览整体打挂
        if (!cancelled) setState({ status: 'done', text: result?.text ?? '' })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled, wanted, key, src, path, attempt])

  const start = useCallback(() => {
    if (!key) return
    setStartedKey(key)
    // 已经识别过的再点一次 = 重跑（空结果 / 失败本来就不在 memo 里，命中缓存也是零成本）
    setAttempt((n) => n + 1)
  }, [key])

  const retry = useCallback(() => {
    if (!key) return
    memo.delete(key)
    forceRef.current = true
    setStartedKey(key)
    setAttempt((n) => n + 1)
  }, [key])

  return { state, start, retry }
}
