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
import { t, tpl } from '@/ui/i18n'
import {
  NOTIFY_INTERVAL_MS,
  shouldHintIdle,
} from '@/infrastructure/tools/output-store'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'

/**
 * PTY 终端块 —— 用 xterm.js 渲染伪控制台（ConPTY）的原始 VT 流。
 *
 * 为什么需要它：`execute_command` 在 Windows 上已把 stdio 换成 ConPTY
 * （`docs/pty-research.md` §8 Step 1），输出是**带光标控制的 VT 流**
 * （`\x1b[87X` 擦除字符、`\x1b]0;…\x07` 改窗口标题、`\x1b[?25l` 光标可见性…）。
 * `<pre>` 表达不了这些语义：进度条会花屏、TUI 会错位。xterm.js 是真正的终端模拟器，
 * 同时天然实现「用户可干预」——键击经 `onData` 直接写入后端伪控制台。
 *
 * 与管道（非 PTY）路径的分工：非 PTY 仍走 `TerminalBlock` 的 `<pre>` 渲染，
 * 两条路径互不影响（见 `TerminalView` 的路由）。
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
 * 终端字体栈 —— **必须是真等宽**（取法对齐桌面上那份 xterm-demo）。
 *
 * ⚠️ 不能再用 `AlimamaAgileVF-Thin`（`<pre>` 版终端的字体）：它是**比例字体**
 * （实测 'W'=0.672em、'i'=0.147em、'1'=0.300em、空格 0.240em），而 xterm 会把每个
 * 字符塞进同一个固定宽的格子里（格子宽度按 'W' 这种最宽字形量出）→ 窄字符两侧被
 * 撑出大量空白，整行看起来「又宽又散」，列数也被算小、硬折行提前发生。
 * `<pre>` 用浏览器自然比例排版看不出问题，换成网格渲染（xterm）就暴露了。
 */
const PTY_FONT =
  "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"

/**
 * 拆出文本**末尾连续的 `\r`**：`[可直接写入的部分, 需挂起并入下次写入的 `\r`]`。
 *
 * 为什么单独挂起尾部 `\r`：ConPTY 的「行重绘」会先把光标 `\r` 回行首、**下一帧**才发整行
 * 内容（末尾再用 `\e[<row>;<col>H` 把光标放回原位）。若把那半截 `\r` 单独渲染一帧，光标块
 * 会瞬移到行首再弹回。挂起它本身不产生任何可见像素，合入下一次写入即可消除中间帧。
 * 纯函数，便于单测。
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
 * 挂起尾部 `\r` 的**兜底写入延时**。
 *
 * ⚠️ 必须**大于**输出节流窗口（`NOTIFY_INTERVAL_MS`）：前端把 PTY 分片交给 xterm 是按
 * **节流后的通知**来的，相邻两次通知的最大间隔约等于一个节流窗口。若兜底延时 ≤ 该窗口，
 * 「先导 `\r`」可能在紧随其后的重绘到达**之前**就被写出去 → 又渲染出「光标闪到行首」的
 * 中间帧，等于把问题带回来。这里取「节流窗口 + 70ms」留足余量。
 */
export const CR_HOLD_FLUSH_MS = NOTIFY_INTERVAL_MS + 70

/**
 * 写入缓冲：**合并 ConPTY 行重绘的先导 `\r`，绝不在一帧里以 `\r` 收尾**。
 *
 * ConPTY 的「行重绘」分两次写：先单独发一个 `\r`（光标回行首），约 10~25ms 后才发整行
 * 内容（末尾用 `\e[<row>;<col>H` 把光标放回原位）。若把那个 `\r` 单独渲染一帧，就会看到
 * **光标块瞬移到当前行最前面**再弹回 —— 即「删除时光标闪到行首」。
 *
 * 策略（`push`）：
 *   1. 增量中**不含末尾 `\r`** 的部分 → **立即写入**（不引入额外延迟）；
 *   2. 末尾连续的 `\r` → 挂起，等下一段增量合并后一起写；
 *   3. **兜底防抖**（`flushDelayMs`）：若窗口内始终没有后续增量，就把挂起的 `\r` 补写掉，
 *      避免极少数「只有一个孤立 `\r` 且再无输出」时，光标长期停在错误列。
 *
 * 抽成类是为了**可测**：`write` 回调可注入，定时器可用 fake timers 驱动。
 */
export class PendingCrWriter {
  private hold = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushDelayMs: number,
    private readonly write: (text: string) => void,
  ) {}

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

  /** 把挂起的 `\r` 立即写掉（兜底：窗口内没有后续增量）。 */
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

export function XtermTerminal({
  stream,
  running,
  toolCallId,
  syncResize = true,
  onResize,
}: {
  /** 伪控制台原始输出（累积串，含 ANSI/VT 控制序列） */
  stream: string
  /** 是否仍在运行（运行中允许键击输入） */
  running: boolean
  /** PTY 会话 key：与后端「运行中命令」注册表一致，直接用 toolCallId */
  toolCallId: string
  /**
   * 是否把尺寸同步给后端伪控制台。
   *
   * 全屏态是「双实例同时渲染」（见 `XtermTerminalBlock`），两份的列宽不同；
   * 若两份都调 `pty_resize` 会互相覆盖后端尺寸 → 只让**原位那份**同步尺寸，
   * 全屏那份纯渲染（伪控制台输出按列宽硬换行，更宽的多余右侧留白无害）。
   */
  syncResize?: boolean
  /** 尺寸变化回调（列×行），供外层状态栏展示；用 ref 持有避免 effect 依赖抖动 */
  onResize?: (size: { cols: number; rows: number }) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** 已写入终端的内容（用于增量写入；见下方注释） */
  const writtenRef = useRef('')
  /**
   * 「先导 `\r`」合并写入缓冲（见 `writeDelta` / `PendingCrWriter`）。
   * 跨 effect 共享：创建时的整段写入与后续增量写入都走同一套「不以 `\r` 收尾」逻辑。
   */
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
  /**
   * 上次已上报的尺寸。
   *
   * 用于去重：ResizeObserver 会反复回调，即使尺寸没变也会调 `syncSize`；
   * 每次真去 `pty_resize` 都会让 ConPTY 整屏重绘并补出空行（见 docs/pty-research.md §5.7）。
   */
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  /**
   * `pty_resize` 重试令牌。
   *
   * 前端 `fit()` 与后端 `create` 是竞态的（实测 fit 常早 ~0.9s 到达，此时会话尚未注册
   * → 后端返回 false）。每次上报生成一个新令牌，旧令牌的待重试任务自动作废，
   * 避免发出过期尺寸。
   */
  const resizeGenRef = useRef(0)
  const resizeRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 把一段增量交给 xterm —— 经 `PendingCrWriter` 合并「先导 `\r`」，
   * 绝不在一帧里以 `\r` 收尾（否则光标会闪到行首，见 `PendingCrWriter` 注释）。
   */
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
      // 外观对齐 demo：光标闪烁 + 块状光标 + 略大字号与行高
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      lineHeight: 1.25,
      fontFamily: PTY_FONT,
      // 有界滚动缓冲：内存有界（§6.2，避免 cat 大文件把内存打爆）
      scrollback: 2000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    /**
     * 把终端尺寸同步给后端伪控制台。
     *
     * ⚠️ 两条硬约束（否则会出现「第一次运行多出很多空行」）：
     *   1. **容器还没布局（宽高为 0）时绝不 resize** —— 此时 `fit()` 量不出尺寸，
     *      而 `term.cols/rows` 还是 xterm 默认的 80×24；把它推给后端就是用**错误的行数**
     *      去 `ResizePseudoConsole`，而 ConPTY 在「屏幕已有内容」后 resize 会整屏重绘、
     *      并按新行数在内容下方补空行（实测：空行数 = 新行数 − 内容行数）。
     *      「程序启动后第一次运行终端」正是容器还处于「隐藏/未布局」的那次。
     *   2. **尺寸没变就不重复上报** —— ResizeObserver 会反复回调，重复 resize 同样会白刷空行。
     */
    /**
     * 把尺寸发给后端伪控制台；**未命中会话时短重试**。
     *
     * ⚠️ 为什么需要重试：前端 `fit()` 与后端 `create` 存在竞态。实测 fit 常早 ~0.9s 到达，
     * 此时后端 PTY 会话还没注册、返回 false。若只发一次，尺寸就永远同步不过去，
     * 伪控制台会停在 240×50 → 与真实尺寸不符 → ConPTY 每次重绘都补一堆空行。
     * 后端同时把尺寸写进缓存（见 pty_session::pty_resize），双保险。
     */
    function sendResize(cols: number, rows: number) {
      resizeGenRef.current += 1
      const gen = resizeGenRef.current
      const attempt = (n: number) => {
        if (gen !== resizeGenRef.current || !termRef.current) return
        invoke<boolean>('pty_resize', { toolCallId, cols, rows })
          .then((ok) => {
            // 未命中会话（后端 PTY 尚未注册，见上方说明）→ 稍后重试
            if (!ok && n < 8) {
              resizeRetryRef.current = setTimeout(() => attempt(n + 1), 120)
            }
          })
          .catch(() => { })
      }
      attempt(0)
    }

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
    syncSize()

    // 键击/粘贴直送伪控制台 —— 用户「插键盘」的核心通道。
    // 走 Tauri 命令而不是引擎事件总线，因此不污染 AgentEventType 四方契约（§6.3）。
    const inputSub = term.onData((data) => {
      if (!runningRef.current) return
      invoke('pty_write', { toolCallId, data }).catch(() => { })
    })

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
      term.dispose()
      termRef.current = null
      writtenRef.current = ''
      crWriterRef.current?.reset()
      lastSizeRef.current = null
    }
    // 只随 toolCallId 重建；stream 的变化由下方的增量 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId])

  /**
   * 增量写入。
   *
   * PTY 输出刷新极快（进度条、`npm install`），改造前 `<pre>` 版每次通知都重跑
   * **整个累积字符串**（O(n²)，会烧 CPU 并卡 UI，见 §6.2）。这里只写增量：
   * 常态下 `stream` 只是尾部变长，直接 `slice` 出新增部分交给 xterm；
   * 只有前缀对不上（运行态→完成态换数据源、流被重置）才整体重放一次。
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

  return <div className="pty-terminal-body-wrapper">
    <div className="pty-terminal-body" ref={hostRef} />
  </div>


}

/**
 * 命名控制键按钮表（Step 2 ③）。
 *
 * 只发键名，字节映射统一在 Rust 侧（`pty_session::key_sequence`）—— 命名→字节只有一份实现。
 */
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
 * 「疑似等待输入」的空闲秒数（Step 2 ④）。
 *
 * 纯本地计时（零后端成本）：未运行 / 无输出记录 / 未满阈值 → null。
 * 定时器**只在运行中挂**（命令结束即卸下，无开销）。
 */
export function useIdleSeconds(
  running: boolean,
  lastOutputAt?: number,
): number | null {
  const [secs, setSecs] = useState<number | null>(null)
  useEffect(() => {
    if (!running) {
      setSecs(null)
      return
    }
    const compute = () => {
      const now = Date.now()
      if (!shouldHintIdle(now, lastOutputAt, running)) return null
      return Math.floor((now - (lastOutputAt as number)) / 1000)
    }
    setSecs(compute())
    const id = setInterval(() => setSecs(compute()), 1000)
    return () => clearInterval(id)
  }, [running, lastOutputAt])
  return secs
}

/**
 * PTY 终端块（完整形态：header + 终端 + 提示）。
 *
 * `status` 由调用方传入：既复用 `TerminalStatus`（退出码徽标），
 * 又避免 `TerminalBlock.tsx ⇄ XtermTerminal.tsx` 的循环依赖。
 *
 * 全屏（Step 2 ⑤）与 `<pre>` 版 `TerminalBlock` 同构：原位 + `createPortal` 到 body
 * 两份同时渲染。xterm 的写入是**自包含**的（首帧整段 `write(stream)`），因此全屏那份
 * 在首帧就拿到完整 scrollback，**不需要** serialize/restore，原位那份也保持挂载
 * （避免虚拟列表条目变矮触发重测量 / 滚动跳动）。代价是全屏期间同一条流被解析两遍
 * （≈2× CPU），属短时交互态，可接受（docs/pty-research.md §7 #19）。
 */
export function XtermTerminalBlock({
  title,
  cmd,
  cwd,
  fileLabel,
  note,
  status,
  stream,
  running,
  toolCallId,
  lastOutputAt,
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
  stream: string
  running: boolean
  toolCallId: string
  /** 最近一次输出时间戳（④ 空闲提示用） */
  lastOutputAt?: number
  onKill?: () => void
  killing?: boolean
}) {
  const [fullscreen, setFullscreen] = useState(false)
  // ② 接管状态：本地镜像后端会话（命令已结束时后端返回 false → 复位）
  const [held, setHeld] = useState(false)
  // 终端列×行（底部状态栏展示；由 XtermTerminal 的 fit() 回传）
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  const idleSeconds = useIdleSeconds(running, lastOutputAt)

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
          <div className="pty-cmd-line">
            {cwd && <span className="pty-cwd">{cwd}</span>}
            $ {cmd}
          </div>
        )}
        <XtermTerminal
          stream={stream}
          running={running}
          toolCallId={toolCallId}
          syncResize={!isFull}
          onResize={setSize}
        />
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
    </>
  )
}
