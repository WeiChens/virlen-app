import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { invoke } from '@tauri-apps/api/core'
import { reaction } from 'mobx'
import { t } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { textMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import { copyText, readClipboardText } from '@/utils/clipboard'
import { NOTIFY_INTERVAL_MS } from '@/infrastructure/tools/output-store'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import { SandboxBadge } from './SandboxBadge'

/**
 * PTY 终端块：用 xterm.js 渲染伪控制台（ConPTY）的原始 VT 流。
 *
 * `execute_command` 在 Windows 上已把 stdio 换成 ConPTY，输出是带光标控制的 VT 流（擦除字符、
 * 改窗口标题、光标可见性…）。`<pre>` 表达不了这些语义：进度条花屏、TUI 错位。xterm 是真终端模拟器，
 * 也天然支持「用户可干预」—— 键击经 `onData` 直接写进后端伪控制台。
 *
 * 非 PTY（管道）路径仍走 `TerminalBlock` 的 `<pre>`，两条路径互不影响（见 `TerminalView` 的路由）。
 */

/** 从主题变量取色（xterm 只接受具体颜色值，不能直接用 CSS 变量）。 */
function cssColor(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value || fallback
}

/** 终端主题：沿用 `<pre>` 版终端同一套令牌，保证两种渲染观感一致。 */
function terminalTheme() {
  const background = cssColor('--terminal-bg', '#191a1b')
  const foreground = cssColor('--terminal-text', '#ffffff')
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    black: background,
    red: cssColor('--terminal-stderr', '#d82222'),
    green: '#0fcd55',
    yellow: '#f59e0b',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#22d3ee',
    white: foreground,
    brightBlack: cssColor('--terminal-text-secondary', '#8b949e'),
  }
}

/**
 * 终端字体栈 —— 必须是真等宽。
 * 不能用 `AlimamaAgileVF-Thin`（`<pre>` 版终端用的那个）：它是比例字体，而 xterm 把每个字符塞进
 * 同宽格子（按 'W' 量出）→ 窄字符两侧留空、列数算小、硬折行提前。
 */
const PTY_FONT =
  "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/** 终端字号档位 → px（对应「设置 → 通用 → 字体大小」）。取值与聊天区代码块 `CODE_FONT_PX` 一致：medium 13px，small / large 各 ±1px。 */
export const PTY_FONT_PX: Record<'small' | 'medium' | 'large', number> = {
  small: 12,
  medium: 13,
  large: 14,
}

/** 读取当前字号档位对应的终端字号（px）；设置缺失时回落 medium 基线。 */
export function getPtyFontPx(): number {
  const level = settingsState.value.fontSize ?? 'medium'
  return PTY_FONT_PX[level] ?? PTY_FONT_PX.medium
}

/**
 * 拆出文本**末尾连续的 `\r`**：`[可直接写入的部分, 需挂起并入下次写入的 `\r`]`。
 *
 * ConPTY 的「行重绘」先发一个 `\r`（光标回行首）、下一帧才发整行内容。若把这半截 `\r` 单独
 * 渲染一帧，光标块会瞬移到行首再弹回；挂起它不产生任何可见像素，合入下次写入即可消除中间帧。
 */
export function splitTrailingCr(text: string): [string, string] {
  let holdLen = 0
  while (holdLen < text.length && text[text.length - 1 - holdLen] === '\r') {
    holdLen++
  }
  return [
    text.slice(0, text.length - holdLen),
    text.slice(text.length - holdLen),
  ]
}

/**
 * 挂起尾部 `\r` 的兜底写入延时，必须大于输出节流窗口（`NOTIFY_INTERVAL_MS`）：PTY 分片按
 * 节流后的通知交给 xterm，相邻两次通知间隔约一个节流窗口；延时 ≤ 窗口时那个「先导 `\r`」会
 * 赶在重绘到达前写出，又出现「光标闪到行首」。
 */
export const CR_HOLD_FLUSH_MS = NOTIFY_INTERVAL_MS + 70

/**
 * 写入缓冲：**合并 ConPTY 行重绘的先导 `\r`，绝不在一帧里以 `\r` 收尾**。
 *
 * 单独渲染先导 `\r` = 光标块瞬移到行首再弹回（「删除时光标闪到行首」）。策略（`push`）：
 * 不含末尾 `\r` 的部分立即写入；末尾连续 `\r` 挂起等下一段合并；`flushDelayMs` 兜底，
 * 避免孤立 `\r` 后再无输出时光标长期停在错误列。
 * 抽成类是为了可测：`write` 可注入、定时器可用 fake timers 驱动。
 */
export class PendingCrWriter {
  private hold = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushDelayMs: number,
    private readonly write: (text: string) => void,
  ) { }

  /** 追加一段增量。 */
  push(delta: string): void {
    if (!delta) return
    const [toWrite, hold] = splitTrailingCr(this.hold + delta)
    if (toWrite) this.write(toWrite)
    this.hold = hold
    this.cancelTimer()
    if (hold) {
      this.timer = setTimeout(() => this.flush(), this.flushDelayMs)
    }
  }

  /** 把挂起的 `\r` 立即写掉（兜底：窗口内无后续增量）。 */
  flush(): void {
    this.cancelTimer()
    const held = this.hold
    this.hold = ''
    if (held) this.write(held)
  }

  /** 丢弃挂起内容并取消定时器（reset / 卸载）。 */
  reset(): void {
    this.cancelTimer()
    this.hold = ''
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

// 复制 / 粘贴统一走 `utils/clipboard`（与输入框共用同一套兜底，不再各写一份）

/**
 * 伪控制台的**传输层**：键击出去、尺寸进去。
 *
 * 默认实现就是 `execute_command` 那套 Tauri 命令（`pty_write` / `pty_resize`，以 `toolCallId` 为键）；
 * 后台服务的终端弹窗（P3）传自己的实现（`cmd_service_console_*`，以服务 id 为键）——
 * 这样终端组件本体只有一份，「怎么跟后端说话」留给调用方（铁律 1）。
 */
export interface PtyTransport {
  /** 写入键击 / 粘贴内容（fire-and-forget；失败不该影响终端渲染） */
  write(data: string): void | Promise<unknown>
  /** 上报尺寸；返回 `false` = 会话还没准备好（调用方会短重试） */
  resize(cols: number, rows: number): Promise<boolean>
}

export function XtermTerminal({
  stream,
  running,
  toolCallId,
  syncResize = true,
  transport,
  autoFocus = false,
  onResize,
}: {
  /** 伪控制台原始输出（累积串，含 ANSI/VT 控制序列） */
  stream: string
  /** 是否仍在运行（运行中允许键击输入） */
  running: boolean
  /** PTY 会话 key：默认传输层的命令参数，也是实例重建的依据 */
  toolCallId: string
  /**
   * 是否把尺寸同步给后端伪控制台。全屏态是「双实例同时渲染」且两份列宽不同，都调 `pty_resize`
   * 会互相覆盖 → 同一时刻只让一份独占同步（见下方「尺寸同步权交接」effect）。
   */
  syncResize?: boolean
  /** 自定义传输层（默认：`pty_write` / `pty_resize`）；后台服务弹窗用它接自己的命令 */
  transport?: PtyTransport
  /** 挂载后是否立即把键盘焦点给终端（弹窗场景：打开就能敲） */
  autoFocus?: boolean
  /** 尺寸变化回调（列×行），供外层状态栏展示；用 ref 持有避免 effect 依赖抖动 */
  onResize?: (size: { cols: number; rows: number }) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** 已写入终端的内容（增量写入的基准） */
  const writtenRef = useRef('')
  /** 「先导 `\r`」合并缓冲（见 `PendingCrWriter`）；创建时的整段写入与后续增量共用同一套逻辑。 */
  const crWriterRef = useRef<PendingCrWriter | null>(null)
  // 用 ref 持有 running，避免把 running 放进创建 effect 的依赖里频繁重建终端
  const runningRef = useRef(running)
  runningRef.current = running
  // 同上：实例创建后角色（原位 / 全屏）不再变，捕获初始值即可
  const syncResizeRef = useRef(syncResize)
  syncResizeRef.current = syncResize
  // 同上：尺寸回调每次渲染都是新引用，用 ref 持有，避免进 effect 依赖导致终端重建
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  // 同上：传输层 / 自动聚焦用 ref 持有（它们不该把终端重建掉 —— 重建会丢 scrollback 与已输入内容）
  // ⚠️ 默认实现必须**每次渲染都重新赋值**：它闭包捕获 `toolCallId`，而终端实例会随 `toolCallId`
  // 变化重建（创建 effect 的依赖）—— 若只在首次渲染建闭包，重建后键击 / 尺寸会打到**上一个** PTY 会话键。
  const defaultWrite = (data: string) => invoke('pty_write', { toolCallId, data })
  const defaultResize = (cols: number, rows: number) =>
    invoke<boolean>('pty_resize', { toolCallId, cols, rows })
  const writeRef = useRef<(data: string) => void | Promise<unknown>>(defaultWrite)
  const resizeRef = useRef<(cols: number, rows: number) => Promise<boolean>>(
    defaultResize,
  )
  writeRef.current = transport?.write ?? defaultWrite
  resizeRef.current = transport?.resize ?? defaultResize
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus
  /** 上次已上报的尺寸（用于去重）：ResizeObserver 会反复回调，而每次真 `pty_resize` 都让 ConPTY 整屏重绘并补空行。 */
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  /** `pty_resize` 重试令牌：每次上报换新令牌，旧令牌的待重试任务自动作废，避免发出过期尺寸。 */
  const resizeGenRef = useRef(0)
  const resizeRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前实例的 `syncSize`（在创建 effect 内定义）：「尺寸同步权交接」effect 收尾时要强制重发一次尺寸。 */
  const syncSizeRef = useRef<(() => void) | null>(null)

  /** 右键菜单（关闭行为 / 贴边钳制 / 层级都由 ContextMenu 处理；终端用 dark 皮肤）。 */
  const menu = useContextMenu<void>()
  /** 强制重渲染用：「全选」后要重读 `hasSelection()` 才解除「复制」禁用（xterm 的选区不是 React 状态）。 */
  const [, forceMenuRender] = useState(0)

  /** 把一段增量交给 xterm（经 `PendingCrWriter` 合并「先导 `\r`」，绝不在一帧里以 `\r` 收尾）。 */
  const writeDelta = useCallback((delta: string) => {
    if (!delta) return
    let writer = crWriterRef.current
    if (!writer) {
      writer = new PendingCrWriter(CR_HOLD_FLUSH_MS, (text) =>
        termRef.current?.write(text),
      )
      crWriterRef.current = writer
    }
    writer.push(delta)
  }, [])

  // 创建终端：一个 toolCallId 一个实例
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      // PTY 流里的 \n 直接换行（不依赖 \r\n）
      convertEol: true,
      // 外观对齐 demo：光标闪烁 + 块状光标 + 行高 1.25
      cursorBlink: true,
      cursorStyle: 'block',
      // 字号跟随设置（见下方「字号跟随」effect）
      fontSize: getPtyFontPx(),
      lineHeight: 1.25,
      fontFamily: PTY_FONT,
      // 有界 scrollback：避免 cat 大文件把内存打爆
      scrollback: 2000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    // 弹窗场景（P3）：打开就把焦点给终端 —— 用户直接敲键盘就能输入，不必先点一下
    if (autoFocusRef.current) term.focus()

    /**
     * 把尺寸发给后端伪控制台；未命中会话时短重试。
     *
     * 重试的原因：前端 `fit()` 与后端 `create` 有竞态（实测 fit 常早 ~0.9s 到达，此时 PTY 会话
     * 还没注册、返回 false）；只发一次则尺寸永远同步不过去，伪控制台停在 240×50，ConPTY 每次
     * 重绘都补一堆空行。后端也把尺寸写进缓存（`pty_session::pty_resize`）兜底。
     */
    function sendResize(cols: number, rows: number) {
      resizeGenRef.current += 1
      const gen = resizeGenRef.current
      const attempt = (n: number) => {
        if (gen !== resizeGenRef.current || !termRef.current) return
        resizeRef.current(cols, rows)
          .then((ok) => {
            // 未命中会话（后端 PTY 尚未注册 / 服务已结束）→ 稍后重试
            if (!ok && n < 8) {
              resizeRetryRef.current = setTimeout(() => attempt(n + 1), 120)
            }
          })
          .catch(() => { })
      }
      attempt(0)
    }

    /**
     * fit + 上报尺寸。两条硬约束（否则「第一次运行会多出很多空行」）：
     * 1. 容器还没布局（宽高 0）时绝不 resize —— `fit()` 量不出尺寸，`term.cols/rows` 还是默认
     *    80×24，推给后端等于用错行数调 `ResizePseudoConsole`；ConPTY 在「屏幕已有内容」后
     *    resize 会整屏重绘并按新行数补空行（实测空行数 = 新行数 − 内容行数）；
     * 2. 尺寸没变就不重复上报 —— ResizeObserver 会反复回调，重复 resize 同样白刷空行。
     */
    const syncSize = () => {
      const hostEl = hostRef.current
      if (!hostEl || hostEl.clientWidth <= 0 || hostEl.clientHeight <= 0) return
      try {
        fit.fit()
      } catch {
        // 极少数情况下 fit 仍会抛错 → 本次跳过，等下一次 ResizeObserver 回调
        return
      }
      if (term.cols <= 0 || term.rows <= 0) return
      const last = lastSizeRef.current
      if (last && last.cols === term.cols && last.rows === term.rows) return
      lastSizeRef.current = { cols: term.cols, rows: term.rows }
      onResizeRef.current?.({ cols: term.cols, rows: term.rows })
      if (syncResizeRef.current) {
        // 尺寸同步给后端伪控制台，否则折行位置与用户看到的终端不一致
        sendResize(term.cols, term.rows)
      }
    }
    syncSizeRef.current = syncSize
    syncSize()

    // 键击直送伪控制台 —— 用户「插键盘」的核心通道。走 Tauri 命令而非引擎事件总线，不污染 AgentEventType 契约。
    const inputSub = term.onData((data) => {
      if (!runningRef.current) return
      // 传输层可能是 async（Tauri 命令）—— 统一吃掉拒绝，键击丢失不该弹错 / 报未处理拒绝
      void Promise.resolve(writeRef.current(data)).catch(() => { })
    })

    // Ctrl+C / Cmd+C 智能复制（Windows Terminal / VS Code 的通用约定）：有选区 → 复制并拦下（\x03
    // 不再发给伪控制台）；无选区 → 放行，维持「Ctrl+C 发送 SIGINT」。handler 对 keydown / keypress /
    // keyup 都会被调用，只拦 keydown；用 ev.code 兼容非拉丁键盘布局（俄语布局下 e.key 不是 'c'）。
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const isCopyCombo =
        (ev.key?.toLowerCase() === 'c' || ev.code === 'KeyC') &&
        (ev.ctrlKey || ev.metaKey) &&
        !ev.shiftKey &&
        !ev.altKey
      if (!isCopyCombo || !term.hasSelection()) return true
      ev.preventDefault()
      const text = term.getSelection()
      term.clearSelection()
      void copyText(text)
      // false = xterm 不再处理该键，\x03 不会经 onData → pty_write 发出去
      return false
    })

    /**
     * 滚轮：终端滚到顶 / 底后**截断滚动链**，别把外层消息列表一起滚走。
     *
     * 根因：xterm 6 的回滚是 VS Code `SmoothScrollableElement` 的 JS 实现，其 wheel 处理器只在
     * **真的滚动成功**时 `preventDefault() + stopPropagation()`；「已到边界、滚不动」的那一下两者
     * 都不做 → 浏览器把滚轮顺着滚动链交给外层 `.chat-messages-container`。
     *
     * 对策：在**外层、冒泡阶段**补监听 —— 能收到事件就说明 xterm 没消费（消费时会 stopPropagation），
     * 即终端已到边界；此时只 `preventDefault()` 取消滚动链传导，不碰 xterm 自己的 JS 滚动。
     *
     * 两条红线：① 绝不能用捕获阶段（xterm 的处理器看到 `defaultPrevented` 就整体退出，抢先拦会把
     * 终端滚轮彻底打死）；② 输出一屏装得下时（`baseY === 0`）不拦，否则成「滚轮死区」。
     */
    const onWheel = (ev: WheelEvent) => {
      if (ev.defaultPrevented) return
      // baseY = 「完全滚到底时视口顶行在缓冲里的行号」：> 0 说明有回滚缓冲
      if (term.buffer.active.baseY <= 0) return
      ev.preventDefault()
    }
    host.addEventListener('wheel', onWheel, { passive: false })

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(syncSize) : null
    observer?.observe(host)

    // 首帧：已有累积输出时整体写入（之后走增量）
    if (stream) {
      writeDelta(stream)
      writtenRef.current = stream
    }

    return () => {
      // 作废进行中的 pty_resize 重试链（尺寸变更 / 卸载后不再上报）
      resizeGenRef.current += 1
      if (resizeRetryRef.current) clearTimeout(resizeRetryRef.current)
      observer?.disconnect()
      inputSub.dispose()
      host.removeEventListener('wheel', onWheel)
      term.dispose()
      termRef.current = null
      writtenRef.current = ''
      crWriterRef.current?.reset()
      lastSizeRef.current = null
      syncSizeRef.current = null
    }
    // 只随 toolCallId 重建；stream 的变化由下方的增量 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId])

  /**
   * 字号跟随「设置 → 字体大小」。用 `reaction` 而不是加进创建 effect 的依赖：实例只随 `toolCallId`
   * 重建（重建会丢 scrollback / 滚动位置 / 已输入内容），而字号是命令式写在实例上的。
   *
   * 字号变 → 字符格宽高变 → 必须重算列×行并同步给后端，否则折行位置与用户看到的不一致。
   * 直接复用 `syncSize()`：它自带「未布局不上报」「尺寸未变不上报」两道保护。
   */
  useEffect(() => {
    const applyFontPx = () => {
      const term = termRef.current
      if (!term) return
      const px = getPtyFontPx()
      if (term.options.fontSize === px) return
      term.options.fontSize = px
      syncSizeRef.current?.()
    }
    // 首帧字号已由创建 effect 初始化，这里只负责后续变更
    return reaction(
      () => settingsState.value.fontSize,
      () => applyFontPx(),
    )
  }, [])

  /**
   * 尺寸同步权交接。同一时刻只允许一份实例调 `pty_resize`（否则互相覆盖后端尺寸）：
   * - 拿回同步权（退出全屏，false → true）：原位尺寸没变，`lastSizeRef` 去重会让它跳过上报 →
   *   后端永远停在「全屏那次」的大尺寸上，故清空去重缓存并强制重发（顺带重跑 `fit()`）；
   * - 交出同步权（进入全屏，true → false）：作废本实例的 `pty_resize` 重试链，
   *   免得它在全屏实例上报后又用旧尺寸覆盖回去。
   */
  const prevSyncResizeRef = useRef(syncResize)
  useEffect(() => {
    const prev = prevSyncResizeRef.current
    prevSyncResizeRef.current = syncResize
    if (prev === syncResize) return
    if (syncResize) {
      lastSizeRef.current = null
      syncSizeRef.current?.()
    } else {
      resizeGenRef.current += 1
      if (resizeRetryRef.current !== null) {
        clearTimeout(resizeRetryRef.current)
        resizeRetryRef.current = null
      }
    }
  }, [syncResize])

  /**
   * 增量写入。PTY 输出刷新极快，过去 `<pre>` 版每次通知都重跑整个累积串（O(n²)，烧 CPU 卡 UI）；
   * 这里常态只 `slice` 出新增部分交给 xterm，只有前缀对不上（换数据源 / 流被重置）才整体重放。
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const written = writtenRef.current
    if (stream === written) return
    if (written && stream.startsWith(written)) {
      writeDelta(stream.slice(written.length))
    } else {
      term.reset()
      // 整体重放：先清掉挂起的 `\r`，避免把上一轮的尾部错接到新流上
      crWriterRef.current?.reset()
      writeDelta(stream)
    }
    writtenRef.current = stream
  }, [stream, writeDelta])

  /** 菜单动作：复制当前选区（复制完清选区，对齐 Windows Terminal 的习惯）。 */
  async function copySelection() {
    const term = termRef.current
    if (!term) return
    const text = term.getSelection()
    if (!text) return
    await copyText(text)
    term.clearSelection()
    term.focus()
  }

  /**
   * 菜单动作：读剪贴板 → 送进伪控制台。走 `term.paste` 而非直接 `pty_write`：xterm 会做
   * CRLF→CR 规整，并在 bracketed paste 模式（PSReadLine 默认开）下把整段包成
   * `\x1b[200~…\x1b[201~`，多行粘贴不会被当成「逐行回车」执行。
   */
  async function pasteFromClipboard() {
    const term = termRef.current
    if (!term || !runningRef.current) return
    const text = await readClipboardText()
    if (!text) return
    term.paste(text)
    term.focus()
  }

  /** 菜单动作：全选（选完菜单保持打开，「复制」随即可用：右键 → 全选 → 复制）。 */
  function selectAllForCopy() {
    const term = termRef.current
    if (!term) return
    term.selectAll()
    // 触发一次重渲染，让「复制」按钮按新的选区状态解除禁用
    forceMenuRender((n) => n + 1)
    term.focus()
  }

  /** 菜单项：复制 / 粘贴 / 全选。两个 disabled 都渲染时现算（选区状态、命令是否还在运行）。 */
  const menuItems: ContextMenuItem[] = [
    {
      key: 'copy',
      label: t('复制'),
      disabled: !termRef.current?.hasSelection(),
      onClick: copySelection,
    },
    {
      key: 'paste',
      label: t('粘贴'),
      disabled: !runningRef.current,
      onClick: pasteFromClipboard,
    },
    {
      key: 'select-all',
      label: t('全选'),
      keepOpen: true,
      onClick: selectAllForCopy,
    },
  ]

  // 滚轮拦截在创建 effect 里（`onWheel`），此处不重复处理
  return (
    <div
      className="pty-terminal-body-wrapper"
      onContextMenu={(e) => menu.openAt(e, undefined)}>
      <div className="pty-terminal-body" ref={hostRef} />
      {/* ContextMenu 经 createPortal 挂 body（消息列表祖先带 transform/overflow，fixed 会被牵连） */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={menuItems}
          onClose={menu.close}
          dark
        />
      )}
    </div>
  )
}

/** 命名控制键按钮表：只发键名，字节映射统一在 Rust 侧（`pty_session::key_sequence`）。 */
const PTY_KEY_BUTTONS: Array<{ key: string; label: string; title: string }> = [
  { key: 'ctrl+d', label: 'Ctrl+D', title: '发送 Ctrl+D（EOF）' },
]

/** PTY 按键条：触控板 / 触屏场景下快速发送控制键。 */
function PtyKeyBar({ toolCallId }: { toolCallId: string }) {
  return (
    <div className="pty-key-bar">
      {PTY_KEY_BUTTONS.map((b) => (
        <button
          key={b.key}
          className="terminal-ctl-btn"
          title={t(b.title)}
          onClick={() => {
            invoke('pty_key', { toolCallId, keys: [b.key] }).catch(() => { })
          }}>
          {b.label}
        </button>
      ))}
    </div>
  )
}

/**
 * PTY 终端块（header + 终端 + 提示）。`status` 由调用方传入：既复用 `TerminalStatus`（退出码徽标），
 * 又避免 `TerminalBlock.tsx ⇄ XtermTerminal.tsx` 的循环依赖。
 *
 * 全屏与 `<pre>` 版 `TerminalBlock` 同构：原位 + `createPortal` 到 body 两份同时渲染。xterm 写入是
 * 自包含的（首帧整段 `write(stream)`），全屏那份首帧就有完整 scrollback，**不需要** serialize/restore；
 * 原位那份保持挂载，避免虚拟列表条目变矮触发重测量 / 滚动跳动。代价是全屏期间同一条流解析两遍
 * （≈2× CPU），短时交互态，可接受。
 *
 * 尺寸同步：双实例不能同时上报（会互相覆盖后端尺寸），同一时刻只让一份**独占** —— 见 `syncResize`
 * 与上方交接 effect。
 */
export function XtermTerminalBlock({
  title,
  cmd,
  cwd,
  fileLabel,
  note,
  status,
  sandbox,
  stream,
  running,
  toolCallId,
  onKill,
  killing,
}: {
  title: string
  /** 命令原文 */
  cmd?: string
  /** 当前工作目录（显示在 `$` 提示符前，即命令实际执行的 cwd） */
  cwd?: string
  /** 命令前的附加信息（如脚本文件短路径） */
  fileLabel?: string
  /** 输出末尾的附加说明（如脚本执行的 note） */
  note?: string
  status?: ReactNode
  /** 本次命令**实际**的沙盒模式（header-left 徽标；缺省则不显示） */
  sandbox?: string
  stream: string
  running: boolean
  toolCallId: string
  onKill?: () => void
  killing?: boolean
}) {
  const [fullscreen, setFullscreen] = useState(false)
  // 接管状态：本地镜像后端会话（命令已结束 → 后端返回 false → 复位）
  const [held, setHeld] = useState(false)
  // 终端列×行（底部状态栏展示；由 XtermTerminal 的 fit() 回传）
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  // 顶部 `$ cmd` 行的右键菜单（复制命令）。与终端体自身的选区菜单是两套，互不影响。
  const cmdMenu = useContextMenu<void>()

  // Esc 退出全屏（与 CodeBlock / ImagePreview 等浮层保持一致的操作习惯）
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  /** 渲染终端本体；原位与全屏走同一函数（结构一致），仅类名与 syncResize 不同。 */
  function renderBlock(isFull: boolean) {
    return (
      <div
        className={
          'execute-command-wrapper is-pty' +
          (isFull ? ' is-fullscreen' : '') +
          (running ? '' : ' is-finished')
        }>
        {/* 顶部窗口栏（对齐 xterm-demo：红黄绿圆点 + 右侧操作区；终端尺寸也展示在这里） */}
        <div className="xterm-titlebar">
          <span className="xterm-dot xterm-dot--red" />
          <span className="xterm-dot xterm-dot--yellow" />
          <span className="xterm-dot xterm-dot--green" />
          <SandboxBadge kind={sandbox} />
          {
            held && <span className='xterm-hint'>{t('已接管：超时已暂停（上限 30 分钟）')}</span>
          }
          <div className="terminal-header-actions">
            {size && (
              <span className="xterm-badge">
                {size.cols}×{size.rows}
              </span>
            )}
            {status}
            {running && (
              <button
                className={`terminal-ctl-btn pty-hold-btn${held ? ' is-held' : ''}`}
                onClick={async () => {
                  const next = !held
                  try {
                    const ok = await invoke<boolean>('pty_set_held', {
                      toolCallId,
                      held: next,
                    })
                    // 后端返回 false 表示会话已不存在（命令已结束）→ 复位
                    setHeld(ok ? next : false)
                  } catch {
                    setHeld(false)
                  }
                }}
                title={t(
                  '接管：暂停超时计时，方便你慢慢输入（上限 30 分钟）；期间仍可用「终止」',
                )}>
                {held ? t('交还') : t('接管')}
              </button>
            )}
            {running && <PtyKeyBar toolCallId={toolCallId} />}
            <button
              className="terminal-fullscreen-btn"
              onClick={() => setFullscreen(!fullscreen)}
              title={fullscreen ? t('退出全屏') : t('全屏')}>
              {fullscreen ? <ExitFullScreenSvg /> : <FullScreenSvg />}
            </button>
            {onKill && (
              <button
                className="tool-cmd-kill-btn"
                disabled={killing}
                onClick={onKill}
                title={t('终止执行')}>
                ■ {killing ? t('终止中') : t('终止')}
              </button>
            )}
          </div>
        </div>
        {fileLabel && <div className="pty-cmd-line">📄 {fileLabel}</div>}
        {cmd && (
          <div
            className="pty-cmd-line"
            onContextMenu={(e) => cmdMenu.openAt(e, undefined)}>
            {cwd && <span className="pty-cwd">{cwd}</span>}
            {/* `$` 提示符单独成 span：CSS 置 user-select:none，复制命令时不带上它 */}
            <span className="pty-prompt">$</span> {cmd}
          </div>
        )}
        {/* 尺寸同步权：全屏期间只由全屏实例上报，退出后原位实例夺回（交接 effect 强制重发一次） */}
        <XtermTerminal
          stream={stream}
          running={running}
          toolCallId={toolCallId}
          syncResize={isFull || !fullscreen}
          onResize={setSize}
        />
        {/* 输出末尾的附加说明（如脚本执行的 note）—— 与 `<pre>` 版 TerminalBlock 行为对齐 */}
        {note && <div className="pty-hint">{note}</div>}
      </div>
    )
  }

  return (
    <>
      {renderBlock(false)}
      {fullscreen &&
        createPortal(
          <div className="terminal-fullscreen-layer">
            {renderBlock(true)}
          </div>,
          document.body,
        )}
      {/* 渲染在 renderBlock 之外：避免全屏时两份各弹一个菜单（menu 状态由本组件独占） */}
      {cmdMenu.state && cmd && (
        <ContextMenu
          position={cmdMenu.state.position}
          items={textMenuItems(() => cmd)}
          onClose={cmdMenu.close}
          dark
        />
      )}
    </>
  )
}
