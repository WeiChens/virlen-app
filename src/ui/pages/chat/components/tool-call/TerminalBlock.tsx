import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, tpl } from '@/ui/i18n'
import commentEvent from '@/events/commentEvent'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { Message } from '@/types'
import { ToolOutput, toolOutputStore } from '@/infrastructure/tools/output-store'
import { processTerminalOutput, TerminalOutputParser } from '@/infrastructure/tools/execute/common'
import FullScreenSvg from '@/ui/components/icons/FullScreenSvg'
import ExitFullScreenSvg from '@/ui/components/icons/ExitFullScreenSvg'
import { XtermTerminalBlock } from './XtermTerminal'
import { TerminalConfirmBlock } from './TerminalConfirmBlock'
import { SandboxBadge } from './SandboxBadge'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import { showToast } from '@/ui/components/shared/Toast'

/**
 * 终端输出块（execute_command / execute_script 共用），按「片段」渲染 stdout / stderr / live。
 *
 * 运行态只能是单个 live 片段：后端把 stderr 以 `[stderr] ` 前缀混进同一条流，拼成字符串后无法
 * 还原边界；只有完成态能拿 uiData 的结构化字段分色。
 */

/** 距底部 ≤ 该值视为「贴在底部」：只有此时才跟随新输出 */
export const AT_BOTTOM_THRESHOLD = 40

export interface TerminalSegment {
  kind: 'stdout' | 'stderr' | 'live'
  text: string
}

/** 运行中：整条流作为单个 live 片段；整体做 ANSI / 回车处理，保证 \r 进度条跨 chunk 覆盖正确 */
export function buildLiveSegments(
  raw: string,
  /** 增量解析器（运行中传入）：只解析新增部分；不传＝一次性从头解析 */
  parser?: TerminalOutputParser,
): TerminalSegment[] {
  const text = parser ? parser.feed(raw) : processTerminalOutput(raw)
  if (!text) return []
  return [{ kind: 'live', text }]
}

/**
 * 完成后：优先用 uiData 的 stdout / stderr；流字段缺失时（旧消息 / 调用级异常）回退 content，
 * 整体按 stderr 渲染（它本身就是失败报告）。
 */
export function buildFinishedSegments(
  ui: Record<string, any> | undefined,
  body: string | undefined,
  isError: boolean,
): TerminalSegment[] {
  const hasStreams = !!ui && (ui.stdout != null || ui.stderr != null)
  if (hasStreams) {
    const segments: TerminalSegment[] = []
    const stdout = processTerminalOutput(ui!.stdout ?? '')
    const stderr = processTerminalOutput(ui!.stderr ?? '')
    if (stdout) segments.push({ kind: 'stdout', text: stdout })
    if (stderr) segments.push({ kind: 'stderr', text: stderr })
    return segments
  }
  const text = processTerminalOutput(body ?? '')
  if (!text) return []
  return [{ kind: isError ? 'stderr' : 'stdout', text }]
}

/**
 * 把已贴底的滚动容器跟随到最底部；未贴底返回 false。
 * 必须传真正可滚动的 .code-pre-warpper（max-height + overflow:auto）：内层 .code-pre 对它调 scroll() 是空操作。
 */
export function followBottomIfPinned(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = AT_BOTTOM_THRESHOLD,
): boolean {
  const bottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
  if (bottom >= threshold) return false
  el.scrollTop = el.scrollHeight
  return true
}

/**
 * 终端输出末尾的附加说明（目前只有 execute_script 的脚本删除提示）。
 * 模型侧 note 固定英文，UI 侧按界面语言渲染结构化字段；旧消息缺这些字段 → 回退 note 原文。
 */
export function displayNote(
  ui: Record<string, any> | undefined,
): string | undefined {
  if (!ui) return undefined
  const kind = ui.noteKind
  const path = ui.notePath
  if (kind === 'deleted' && path) {
    return tpl('🗑️ 已删除脚本文件: $__path__', { path })
  }
  if (kind === 'delete_failed' && path) {
    return tpl('⚠️ 脚本文件删除失败: $__path__ — $__error__', {
      path,
      error: ui.noteError ?? '',
    })
  }
  return ui.note
}

/** 完成态状态徽标：退出码 / 失败标识 */
export function TerminalStatus({
  exitCode,
  isError,
}: {
  exitCode?: number | null
  isError?: boolean
}) {
  if (exitCode == null && !isError) return null
  const failed = !!isError || (exitCode != null && exitCode !== 0)
  return (
    <span
      className={`terminal-status${failed ? ' error' : ''}`}
      title={isError ? t('执行失败') : undefined}>
      {exitCode == null ? t('失败') : tpl('退出码: $__code__', { code: exitCode })}
    </span>
  )
}

interface TerminalBlockProps {
  title: string
  /** 命令原文（脚本可能只有 file_path，故可选） */
  cmd?: string
  /** 命令前的一行附加信息（如脚本文件短路径） */
  fileLabel?: string
  /** 输出末尾的附加说明（如脚本执行的 note） */
  note?: string
  segments: TerminalSegment[]
  /** header 右侧状态徽标 */
  status?: ReactNode
  /** 本次命令实际使用的沙盒模式（缺省不显示） */
  sandbox?: string
  /** 运行中：输出增长时自动跟随到底部（仅当用户已在底部附近） */
  followBottom?: boolean
  /** 运行中才有：终止回调 */
  onKill?: () => void
  killing?: boolean
}

export function TerminalBlock({
  title,
  cmd,
  fileLabel,
  note,
  segments,
  status,
  sandbox,
  followBottom,
  onKill,
  killing,
}: TerminalBlockProps) {
  // 全屏态由块自身管理，按钮在 header 右侧（与 CodeBlock 一致）
  const [fullscreen, setFullscreen] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** 全屏副本自己的滚动容器 —— 原位与全屏是两个 DOM，各自独立跟随 */
  const fullScrollerRef = useRef<HTMLDivElement>(null)

  // ref 必须落在真正的滚动容器上（见 followBottomIfPinned）；未挂载的那份为 null，自然跳过
  useEffect(() => {
    if (!followBottom) return
    for (const ref of [scrollerRef, fullScrollerRef]) {
      const el = ref.current
      if (el) followBottomIfPinned(el)
    }
  }, [segments, followBottom])

  // 进入全屏瞬间把新挂载的容器贴到底
  useEffect(() => {
    if (!fullscreen) return
    const el = fullScrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [fullscreen])

  // Esc 退出全屏（与 CodeBlock / ImagePreview 等浮层一致）
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  /** 渲染终端本体：原位与全屏结构一致，isFull 只切换类名与滚动容器 ref */
  function renderBlock(isFull: boolean) {
    return (
      <div
        className={`execute-command-wrapper${isFull ? ' is-fullscreen' : ''}`}>
        <div className="header">
          <span className="title">{title}</span>
          <SandboxBadge kind={sandbox} />
          {status}
          <div className="terminal-header-actions">
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
        <div
          className="code-pre-warpper"
          ref={isFull ? fullScrollerRef : scrollerRef}>
          <pre className="code-pre">
            {fileLabel && (
              <>
                <code style={{ userSelect: 'none' }}>📄 </code>
                <code>{fileLabel + '\n'}</code>
              </>
            )}
            {cmd && (
              <>
                <code style={{ userSelect: 'none' }}>$ </code>
                <code>{cmd + '\n'}</code>
              </>
            )}
            {/* processTerminalOutput 会移除尾部空行，所以片段之间需显式补 \n */}
            {segments.map((seg, i) => (
              <code key={i} className={`terminal-${seg.kind}`}>
                {(i > 0 ? '\n' : '') + seg.text}
              </code>
            ))}
            {note && <code className="terminal-note">{'\n' + note}</code>}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* 原位终端全屏时照样渲染：卸载会让虚拟列表条目变矮 → 重测量 → 滚动跳动 */}
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

/** 订阅 toolOutputStore 的实时输出与 kill 句柄；entry 就地追加，回调同步进来，无需轮询 */
export function useToolLiveOutput(toolCallId: string) {
  const [output, setOutput] = useState<string>(
    () => toolOutputStore.get(toolCallId)?.output ?? '',
  )
  const [entry, setEntry] = useState<ToolOutput | undefined>(() =>
    toolOutputStore.get(toolCallId),
  )

  useEffect(() => {
    const existing = toolOutputStore.get(toolCallId)
    setOutput(existing?.output ?? '')
    setEntry(existing)
    return toolOutputStore.subscribe((id, out) => {
      if (id !== toolCallId) return
      setOutput(out.output)
      setEntry(out)
    })
  }, [toolCallId])

  return { output, entry }
}

/**
 * 这条命令是不是还在**等用户授权**（还没开始跑）。
 *
 * 授权前终端是空的（只有一行 `$ cmd`）—— 看起来像「已经跑完、没输出」；所以等批期间干脆不渲染
 * 终端 / 脚本视图，授权完再出现（写入点 `services/tool-service/command_confirm.ts`）。
 */
export function useAwaitingAuth(toolCallId: string): boolean {
  const [awaiting, setAwaiting] = useState(
    () => !!toolOutputStore.get(toolCallId)?.awaitingAuth,
  )
  useEffect(() => {
    setAwaiting(!!toolOutputStore.get(toolCallId)?.awaitingAuth)
    return toolOutputStore.subscribe((id, out) => {
      if (id !== toolCallId) return
      setAwaiting(!!out.awaitingAuth)
    })
  }, [toolCallId])
  return awaiting
}

/**
 * 终端视图：运行中与完成后共用同一个组件实例 —— 两态 DOM 结构相同，React 复用节点，
 * 切换时滚动位置天然保住，不会把已贴底的视图弹回顶部。
 */
export function TerminalView({
  toolCallId,
  title,
  cmd,
  fileLabel,
  message,
  expand,
}: {
  toolCallId: string
  title: string
  cmd?: string
  fileLabel?: string
  /** 结果消息；为空表示工具仍在运行中 */
  message?: Message
  /** 用户是否展开了本条工具消息（驱动「打开即居中」） */
  expand?: boolean
}) {
  const running = !message
  const { output, entry } = useToolLiveOutput(toolCallId)
  // 实际沙盒模式：运行中取 agent:tool-env 写下的值，完成态以后端权威 uiData.sandbox 为准
  const sandbox = running
    ? entry?.sandbox
    : (message?.uiData?.sandbox ?? entry?.sandbox)
  const [killing, setKilling] = useState(false)
  /** 运行中输出的增量解析器（每条命令一份，换 toolCallId 重建） */
  const liveParserRef = useRef<{ id: string; parser: TerminalOutputParser } | null>(
    null,
  )
  // 「打开即居中」只在用户点开时触发（expand 的 false→true）；不能用 !running ——
  // 运行中的终端未展开也会挂载，命令结束时会把列表拽走
  const rootRef = useAutoCenter(!!expand)
  // 工具实际执行目录：会话 workspace 优先，其次默认 workspace；归一化口径与
  // securityService.getWorkspace 一致，保证 `$` 提示符显示的 cwd 就是命令真正跑的目录
  const workspace =
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace
  const cwd = workspace ? workspace.replace(/\\/g, '/').replace(/\/+$/, '') : ''

  const segments = useMemo(() => {
    if (!running) {
      return buildFinishedSegments(
        message?.uiData,
        message?.content as string,
        !!message?.isError,
      )
    }
    /*
     * 运行中：整段 output 每 50ms 变一次（`output-store` 的节流窗口），所以只把**新增部分**
     * 交给解析器 —— 每次从头解析一遍在几 MB 输出下就是 O(n²)。
     * 换一条命令（toolCallId 变）就换一个解析器，旧状态不能跨命令复用。
     */
    let live = liveParserRef.current
    if (!live || live.id !== toolCallId) {
      live = { id: toolCallId, parser: new TerminalOutputParser() }
      liveParserRef.current = live
    }
    return buildLiveSegments(output, live.parser)
  }, [running, output, message, toolCallId])

  // 只在低频节点（展开 / 命令结束）请外层确认一次贴底；外层虚拟列表已配 anchorTo:'end'
  useEffect(() => {
    commentEvent.emit('requestScrollToBottom')
  }, [running])

  const handleKill = async () => {
    if (!entry?.kill || killing) return
    setKilling(true)
    try {
      // 回调返回 false = 命令不在运行中 —— 不复位的话按钮会永远停在「终止中」
      const hit = await entry.kill()
      if (hit === false) {
        setKilling(false)
        showToast(t('这条命令不在运行中，已改为停止本次运行'), 3000)
      }
    } catch {
      setKilling(false)
    }
  }

  // 终端内确认：命令尚未执行，渲染可编辑命令行而非 xterm。
  // 必须放在所有 hook 之后：pendingConfirm 的出现 / 消失不能改变 hook 调用数量。
  if (running && entry?.pendingConfirm) {
    return (
      <div className="tool-cmd-running" ref={rootRef}>
        <TerminalConfirmBlock
          toolCallId={toolCallId}
          title={title}
          info={entry.pendingConfirm}
        />
      </div>
    )
  }

  /**
   * 授权前不显示终端：此时输出必然是空的（命令还没跑），一块只有 `$ cmd` 的空终端
   * 看着像「已跑完、没输出」。授权结束（允许 / 拒绝 / 收敛）后标记消失，终端才出现。
   * ⚠️ 必须在「终端内确认」之后：那条路径本来就用终端块承载审批输入。
   */
  if (running && entry?.awaitingAuth) return null

  /**
   * PTY 路径走 xterm：输出是带光标控制的原始 VT 流，<pre> 无法表达，也没法键击输入。
   * 运行中用 entry.pty 预判；完成态以 uiData.pty 为准 —— 伪控制台不可用时后端降级回管道并下发 pty:false。
   */
  const isPty = running ? !!entry?.pty : !!(message?.uiData?.pty ?? entry?.pty)
  if (isPty) {
    // 完成态优先用后端原样回传的 stdout（xterm 需要原始流）；退出码 >= 2 的失败只有 content，用它兜底
    const stream = running
      ? output
      : ((message?.uiData?.stdout as string | undefined) ??
        (message?.content as string) ??
        '')
   
    return (
      <div className="tool-cmd-running" ref={rootRef}>
        <XtermTerminalBlock
          title={title}
          cmd={cmd}
          cwd={cwd}
          fileLabel={fileLabel}
          note={running ? undefined : displayNote(message?.uiData)}
          stream={stream}
          running={running}
          toolCallId={toolCallId}
          sandbox={sandbox}
          status={
            running ? undefined : (
              <TerminalStatus
                exitCode={message?.uiData?.exitCode}
                isError={!!message?.isError}
              />
            )
          }
          onKill={running && entry?.kill ? handleKill : undefined}
          killing={killing}
        />
      </div>
    )
  }

  return (
    <div className="tool-cmd-running" ref={rootRef}>
      <TerminalBlock
        title={title}
        cmd={cmd}
        fileLabel={fileLabel}
        note={running ? undefined : displayNote(message?.uiData)}
        segments={segments}
        sandbox={sandbox}
        status={
          running ? undefined : (
            <TerminalStatus
              exitCode={message?.uiData?.exitCode}
              isError={!!message?.isError}
            />
          )
        }
        followBottom={running}
        onKill={running && entry?.kill ? handleKill : undefined}
        killing={killing}
      />
    </div>
  )
}
