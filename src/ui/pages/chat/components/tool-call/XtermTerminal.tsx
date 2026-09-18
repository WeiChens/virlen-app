import { ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { invoke } from '@tauri-apps/api/core'
import { t } from '@/ui/i18n'

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

/** 与 `<pre>` 版终端一致的字体栈 */
const PTY_FONT =
  "'AlimamaAgileVF-Thin', Consolas, 'Cascadia Mono', 'Noto Color Emoji', monospace"

export function XtermTerminal({
  stream,
  running,
  toolCallId,
}: {
  /** 伪控制台原始输出（累积串，含 ANSI/VT 控制序列） */
  stream: string
  /** 是否仍在运行（运行中允许键击输入） */
  running: boolean
  /** PTY 会话 key：与后端「运行中命令」注册表一致，直接用 toolCallId */
  toolCallId: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** 已写入终端的内容（用于增量写入；见下方注释） */
  const writtenRef = useRef('')
  // 用 ref 持有 running，避免把 running 放进创建 effect 的依赖里频繁重建终端
  const runningRef = useRef(running)
  runningRef.current = running

  // 创建终端：一个 toolCallId 一个实例
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      // PTY 流里的 \n 直接换行（不依赖 \r\n）
      convertEol: true,
      cursorBlink: false,
      fontSize: 12,
      fontFamily: PTY_FONT,
      // 有界滚动缓冲：内存有界（§6.2，避免 cat 大文件把内存打爆）
      scrollback: 2000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        // 容器尚未完成布局（宽高为 0）时 fit 会抛错，跳过即可
      }
      if (term.cols > 0 && term.rows > 0) {
        // 尺寸同步给后端伪控制台，否则折行位置与用户看到的终端不一致
        invoke('pty_resize', { toolCallId, cols: term.cols, rows: term.rows }).catch(
          () => {},
        )
      }
    }
    syncSize()

    // 键击/粘贴直送伪控制台 —— 用户「插键盘」的核心通道。
    // 走 Tauri 命令而不是引擎事件总线，因此不污染 AgentEventType 四方契约（§6.3）。
    const inputSub = term.onData((data) => {
      if (!runningRef.current) return
      invoke('pty_write', { toolCallId, data }).catch(() => {})
    })

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(syncSize) : null
    observer?.observe(host)

    // 首帧：已有累积输出时整体写入（之后走增量）
    if (stream) {
      term.write(stream)
      writtenRef.current = stream
    }

    return () => {
      observer?.disconnect()
      inputSub.dispose()
      term.dispose()
      termRef.current = null
      writtenRef.current = ''
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
      term.write(stream.slice(written.length))
    } else {
      term.reset()
      term.write(stream)
    }
    writtenRef.current = stream
  }, [stream])

  return <div className="pty-terminal-body" ref={hostRef} />
}

/**
 * PTY 终端块（完整形态：header + 终端 + 提示）。
 *
 * `status` 由调用方传入：既复用 `TerminalStatus`（退出码徽标），
 * 又避免 `TerminalBlock.tsx ⇄ XtermTerminal.tsx` 的循环依赖。
 */
export function XtermTerminalBlock({
  title,
  cmd,
  fileLabel,
  note,
  status,
  stream,
  running,
  toolCallId,
  onKill,
  killing,
}: {
  title: string
  /** 命令原文 */
  cmd?: string
  /** 命令前的附加信息（如脚本文件短路径） */
  fileLabel?: string
  /** 输出末尾的附加说明（如脚本执行的 note） */
  note?: string
  status?: ReactNode
  stream: string
  running: boolean
  toolCallId: string
  onKill?: () => void
  killing?: boolean
}) {
  return (
    <div className="execute-command-wrapper is-pty">
      <div className="header">
        <span className="title">{title}</span>
        {status}
        <div className="terminal-header-actions">
          {running && (
            <button
              className="terminal-ctl-btn"
              onClick={() => {
                invoke('pty_write', { toolCallId, data: '\x03' }).catch(() => {})
              }}
              title={t(
                '发送 Ctrl+C：仅对正在等待输入的程序有效；中断整个命令请用「终止」',
              )}>
              Ctrl+C
            </button>
          )}
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
      {cmd && <div className="pty-cmd-line">$ {cmd}</div>}
      <XtermTerminal stream={stream} running={running} toolCallId={toolCallId} />
      {running ? (
        <div className="pty-hint">
          {t('可直接在终端中键击或粘贴输入（回车发送）')}
        </div>
      ) : (
        note && <div className="pty-hint pty-note">{note}</div>
      )}
    </div>
  )
}
