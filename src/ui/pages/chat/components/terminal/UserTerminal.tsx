/**
 * UserTerminal — **用户自己的交互终端**（右侧面板里的一个标签）：开始页的「新建终端」或 `Ctrl + \`` 打开。
 *
 * 与服务终端（`service/ServiceTerminal`）的关系：**同一套骨架，不同的主人**。
 * 终端本体都是 `<XtermTerminal>`（`transport` 换成用户终端那三条命令），因此键击 / 粘贴 /
 * 复制 / 全选 / Ctrl+C 智能复制这一整套行为与命令终端完全一致；头部徽标、退出码、只读回放的
 * 措辞也沿用服务终端那一套。差别只有四条：
 * 1. **默认脱壳，但头部不挂徽标**：这里跑的是用户自己敲的命令（与 VS Code 终端一致），
 *    根本不进沙盒 —— 常驻一枚「沙盒已关闭」只是噪声（与 `SandboxBadge` 只画「在沙盒里」同一口径）；
 * 2. **关标签 = 关终端**：`onClose` 由宿主先 `kill` 掉进程树再关标签（服务那边是「终止但留条目」）；
 *    **进程自己结束也走这条路**：用户敲 `exit` / `Ctrl+D` / 命令跑完 → 标签自动关掉，
 *    不留一个「只能看输出」的死终端；
 * 3. **没有终止按钮**：想杀就 `exit` / `Ctrl+D` / 关标签 —— 少一颗按钮，少一次
 *    「按钮按了但进程没死」的困惑；
 * 4. **没有元信息那一行**（`.service-console-meta`：工作目录 / 进程 pid）：用户自己的终端
 *    屏幕上就是全部有用的东西，工作目录已经在标签 tooltip 上（`side-panel` 的 `tab.cwd`），
 *    再占一行只是在压缩终端高度。
 *
 * `active=false` 表示这个标签被切走了：**标签仍然挂着**（切回来要保留屏幕内容），但轮询暂停。
 */
import { useEffect, useMemo, useRef } from 'react'
import { t, tpl } from '@/ui/i18n'
import { resizeUserTerminal, writeUserTerminal } from '@/infrastructure/terminal'
import { serviceStatusLabel } from '../tool-call/service-status'
import { XtermTerminal, type PtyTransport } from '../tool-call/XtermTerminal'
import { shellLabel } from './shells'
import { useUserConsole } from './use-user-console'
// 面板骨架（`.service-console-*`）与「沙盒徽标」都在那边：终端面板只有一套样式，
// 加在这边就会出现「两个终端一个深一个浅」的漂移。⚠️ 不要在这里重新定义 `.service-console-*`。
import '../service/style.scss'

interface Props {
  /** 终端归属会话（关标签时要拿它去 `cmd_terminal_kill`） */
  sessionId: string
  termId: string
  /** 实际使用的 shell 类型（`powershell` / `cmd` / `pwsh` / `gitbash`），头部显示它的展示名 */
  shell: string
  /** 当前是不是激活的标签：切走了就停轮询（内容与偏移都保留） */
  active: boolean
  /** 关闭这个标签（宿主传 `onCloseTab`：先杀进程树再关，见 `chat-view`） */
  onClose: () => void
}

export default function UserTerminal({
  sessionId,
  termId,
  shell,
  active,
  onClose,
}: Props) {
  const { stream, info, gone } = useUserConsole(sessionId, termId, active)

  /**
   * 尺寸上报的开关：只有**明确知道**不能输入（已结束）时才拦下。
   *
   * ⚠️ `info === null`（第一帧：轮询还没回来）必须**放行** —— 终端实例的创建
   * `useLayoutEffect` 就在这一刻上报尺寸，此时拦下会回 `true`（「成功」），而既有逻辑
   * 「成功即不再重试」+「同尺寸不重复上报」→ 这次上报**永远补不回来**，
   * 伪控制台会一直停在创建时的默认尺寸（服务终端踩过同一个坑，见那边注释）。
   */
  const canResizeRef = useRef(true)
  canResizeRef.current = !info || info.interactive

  /** 传输层：键击出去、尺寸进去（与命令终端同形，只是换成用户终端那三条命令） */
  const transport = useMemo<PtyTransport>(
    () => ({
      write: (data) => writeUserTerminal(sessionId, termId, data),
      resize: (cols, rows) =>
        canResizeRef.current
          ? resizeUserTerminal(sessionId, termId, cols, rows)
          : Promise.resolve(true),
    }),
    [sessionId, termId],
  )

  const running = !!info?.interactive

  /**
   * 进程一结束就**关掉这个标签**（用户明确要求）：与服务终端相反 —— 那边「终止但留条目」，
   * 好让人翻最后一屏输出；用户自己的终端没有回看的价值，留一个只能看的死终端只是噪声。
   * ⚠️ `info === null`（首帧，轮询还没回来）不是「已结束」；`closedRef` 防同一次结束
   * 反复上报（宿主那边的 `onClose` 每次渲染都是新的箭头函数）。
   */
  const closedRef = useRef(false)
  useEffect(() => {
    if (!info || info.running || closedRef.current) return
    closedRef.current = true
    onClose()
  }, [info, onClose])
  const status = serviceStatusLabel(
    info ? (info.running ? 'running' : 'exited') : undefined,
    info?.killed,
  )

  // 底部提示：一个问题一行（没有问题时整条不渲染）
  const hints: string[] = []
  if (gone) {
    hints.push(t('该终端已不在列表中（可能已被关闭）'))
  } else if (!info) {
    hints.push(t('正在连接终端…'))
  } else if (!info.running) {
    hints.push(
      info.exitCode != null
        ? tpl('终端已结束（退出码 $__code__），只能查看输出', {
          code: info.exitCode,
        })
        : t('终端已结束，只能查看输出'),
    )
  }
  if (info?.headDropped) {
    hints.push(t('更早的输出已被截断'))
  }

  return (
    <div
      className="service-console-pane user-terminal-pane"
      aria-label={t('终端')}>
      <div className="service-console-head">
        <span className="service-console-name">{shellLabel(shell)}</span>
        <span className="service-spacer" />
        <span className={`service-status is-on-dark ${status.className}`}>
          {status.label}
        </span>
        <button
          type="button"
          className="service-console-close"
          onClick={onClose}
          title={t('关闭并终止终端')}
          aria-label={t('关闭并终止终端')}>
          ✕
        </button>
      </div>

      {/* 终端本体：`running` 只控制「能否输入 / 是否显示光标」，内容始终完整渲染（含已结束的） */}
      <XtermTerminal
        stream={stream}
        running={running}
        toolCallId={`${sessionId}:${termId}`}
        transport={transport}
        autoFocus={active}
      />

      {hints.length > 0 && (
        <div className="service-console-foot">
          {hints.map((h) => (
            <div key={h}>{h}</div>
          ))}
        </div>
      )}
    </div>
  )
}
