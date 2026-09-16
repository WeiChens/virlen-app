import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import commentEvent from '@/events/commentEvent'
import { Message } from '@/types'
import { ToolOutput, toolOutputStore } from '@/infrastructure/tools/output-store'
import { processTerminalOutput } from '@/infrastructure/tools/execute/common'

/**
 * 终端输出块 —— execute_command / execute_script 的运行态与完成态共用。
 *
 * 之前两个 Message 组件各自复制了一份 RunningOutput，且运行态/完成态
 * 的处理方式不同（trim、凭空多一个空行），命令结束时文字会跳变。
 * 这里统一为「片段(segment)」渲染：stdout / stderr / live。
 *
 * 另一个约束：execute/execute_script 把标准错误以 `[stderr] ` 前缀混入同一条
 * 实时流，但它只有起始标记、没有结束标记，拼接成一条字符串后无法可靠还原
 * stream 边界（stderr 之后又出现 stdout 时无法区分）。所以运行态用 live
 * 单片段、不做分色；只有完成态才用 uiData 里的结构化字段着色。
 */

/** 距底部 ≤ 该值视为「贴在底部」：只有此时才跟随新输出，避免打扰正在往上翻的人 */
export const AT_BOTTOM_THRESHOLD = 40

export interface TerminalSegment {
  kind: 'stdout' | 'stderr' | 'live'
  text: string
}

/**
 * 运行中：整条实时流作为单个 live 片段。
 * 先整体做 ANSI/回车处理，保证 \r 进度条跨 chunk 覆盖正确。
 */
export function buildLiveSegments(raw: string): TerminalSegment[] {
  const text = processTerminalOutput(raw)
  if (!text) return []
  return [{ kind: 'live', text }]
}

/**
 * 完成后：优先用结构化的 uiData（stdout/stderr）；
 * 流字段缺失时（命令退出码 >= 2 会抛 CmdError，uiData 不会下发）
 * content 本身就是失败报告（含「退出码 / [标准错误]」），整体按 stderr 渲染。
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
 * 把已贴底的滚动容器跟随到最底部。
 *
 * ⚠️ 必须传「真正可滚动的那个元素」：这里是 .code-pre-warpper
 * （max-height + overflow:auto）。内层 .code-pre 是 overflow:hidden 且无高度
 * 约束，它自己 scrollHeight === clientHeight，对 pre 调 scroll() 是空操作 ——
 * 曾经的实现就挂错了元素，导致运行中的终端永远停在输出顶部。
 *
 * @returns 是否执行了跟随（未贴底则返回 false，即"不打扰"）
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
  tips?: string
  /** 命令原文（脚本可能只有 file_path，故可选） */
  cmd?: string
  /** 命令前的一行附加信息（如脚本文件短路径） */
  fileLabel?: string
  /** 输出末尾的附加说明（如脚本执行的 note） */
  note?: string
  segments: TerminalSegment[]
  /** header 右侧状态徽标 */
  status?: ReactNode
  /** 运行中：输出增长时自动跟随到底部（仅当用户已在底部附近） */
  followBottom?: boolean
  /** 运行中才有：终止回调 */
  onKill?: () => void
  killing?: boolean
}

export function TerminalBlock({
  title,
  tips,
  cmd,
  fileLabel,
  note,
  segments,
  status,
  followBottom,
  onKill,
  killing,
}: TerminalBlockProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)

  // 自动跟随：ref 必须落在真正的滚动容器上（见 followBottomIfPinned 注释）
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !followBottom) return
    followBottomIfPinned(el)
  }, [segments, followBottom])

  return (
    <div className="execute-command-wrapper">
      <div className="header">
        <span className="title">{title}</span>
        {tips && <span className="execute-command-header-tips">{tips}</span>}
        {status}
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
      <div className="code-pre-warpper" ref={scrollerRef}>
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
          {/* processTerminalOutput 会移除尾部的空行，所以片段之间需要显式补 \n */}
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

/**
 * 订阅 toolOutputStore 的实时输出（含 kill 句柄）。
 * store 里的 entry 是就地追加的，subscribe 回调直接同步进来即可，无需轮询。
 */
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
 * 终端视图：运行中与完成后**共用同一个组件实例**。
 *
 * 这样两态渲染出相同的 DOM 结构（.tool-cmd-running > .execute-command-wrapper
 * > .code-pre-warpper），React 直接复用同一批 DOM 节点，于是「运行中 → 完成」
 * 切换时滚动位置由浏览器天然保住，不需要额外的记忆逻辑；也不会因为组件类型
 * 变化而整块重挂载、把已经贴底的视图弹回顶部。
 */
export function TerminalView({
  toolCallId,
  title,
  tips,
  cmd,
  fileLabel,
  message,
}: {
  toolCallId: string
  title: string
  tips?: string
  cmd?: string
  fileLabel?: string
  /** 结果消息；为空表示工具仍在运行中 */
  message?: Message
}) {
  const running = !message
  const { output, entry } = useToolLiveOutput(toolCallId)
  const [killing, setKilling] = useState(false)

  const segments = useMemo(() => {
    if (running) return buildLiveSegments(output)
    return buildFinishedSegments(
      message?.uiData,
      message?.content as string,
      !!message?.isError,
    )
  }, [running, output, message])

  // 只在这个低频节点请外层消息列表确认一次贴底（展开瞬间 / 命令结束瞬间）。
  // 注意外层虚拟列表本身配了 anchorTo:'end'，条目长高时会自动跟随；
  // 这里不再按输出频率反复 emit（原实现每 50ms 发一次，且 isAtEnd 不成立时是空操作）。
  useEffect(() => {
    commentEvent.emit('requestScrollToBottom')
  }, [running])

  const handleKill = () => {
    if (!entry?.kill || killing) return
    setKilling(true)
    entry.kill()
  }

  return (
    <div className="tool-cmd-running">
      <TerminalBlock
        title={title}
        tips={tips}
        cmd={cmd}
        fileLabel={fileLabel}
        note={running ? undefined : message?.uiData?.note}
        segments={segments}
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
