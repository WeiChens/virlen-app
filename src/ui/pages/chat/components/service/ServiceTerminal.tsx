/**
 * ServiceTerminal — 后台服务的**终端面板**（右侧面板里的一个标签）：点服务面板里的行打开。
 *
 * 与四个工具、服务面板的关系：三者读**同一张注册表**（会话隔离）。这里做的是「用户亲自接管这个服务」——
 * 终端本体就是 `execute_command` 用的那个 `<XtermTerminal>`（`transport` 换成服务的三条命令），
 * 因此键击 / 粘贴 / 复制 / 全选 / Ctrl+C 智能复制那一整套行为与命令终端完全一致（铁律 1）。
 *
 * - **运行中**：能敲键盘（键击直送伪控制台）、尺寸随面板自适应、能在这里直接终止；
 * - **已结束**：只读回放（保留窗口里的输出，能复制）——「它到底为什么死了」全靠它；
 * - **管道模式**（非 Windows / 伪控制台不可用）：只读回放 + 如实说明不能输入；
 * - **已从注册表消失**（AI 杀了它并清表）：提示一句，保留最后一屏；
 * - **从「新对话页」的全局视图打开**（P4）：`sessionLabel` 给出归属会话 —— 面板里头也要说得清
 *   「这条是谁的」（同一行服务可能属于另一个会话）。
 *
 * 标签的关闭有两条路：标签栏那颗 ×，以及头部右侧的 ✕（两者走同一个 `onClose` —— 就是容器的
 * `onCloseTab`，邻居口径 / 草稿确认都只在那里写一份）；Esc 仍不接管（面板里按 Esc 不该丢标签）。
 * 头部排布：**名字 / 沙盒在左，状态徽标 + 终止 + 关闭靠右**（状态跟着动作走，左侧留给身份）。
 * `active=false` 表示这个标签被切走了：**标签仍然挂着**（切回来要保留屏幕内容），但轮询暂停。
 */
import { useMemo, useRef } from 'react'
import { t, tpl } from '@/ui/i18n'
import {
  resizeServiceConsole,
  writeServiceConsole,
} from '@/infrastructure/backgroundService'
import { SandboxBadge } from '../tool-call/SandboxBadge'
import { serviceStatusLabel } from '../tool-call/service-status'
import { XtermTerminal, type PtyTransport } from '../tool-call/XtermTerminal'
import { useServiceConsole } from './use-service-console'
import { useServiceKill } from './use-service-kill'
import { useServiceList } from './use-service-list'
import './style.scss'

interface Props {
  sessionId: string
  serviceId: string
  /** 标签上的名字（列表还没轮询回来时先顶着；列表回来以列表为准） */
  name: string
  /** 归属会话标签（只有从「新对话页全局视图」打开时才有 —— 面板里同样要说清这条是谁的） */
  sessionLabel?: string
  /** 当前是不是激活的标签：切走了就停轮询（内容与偏移都保留） */
  active: boolean
  /** 关闭这个标签（宿主传 `onCloseTab`：邻居口径与草稿确认都在容器那边） */
  onClose: () => void
}

export default function ServiceTerminal({
  sessionId,
  serviceId,
  name,
  sessionLabel,
  active,
  onClose,
}: Props) {
  // 列表只为头部那几个字段（名称 / 命令 / 进程 / 沙箱 / 退出码 / 运行时长）：状态与控制台各管一段
  const { services, refresh } = useServiceList(sessionId, active, active)
  const service = services.find((s) => s.id === serviceId)
  const { stream, info, gone } = useServiceConsole(sessionId, serviceId, active)
  const { killing, kill } = useServiceKill(refresh)

  /**
   * 尺寸上报的开关：只有**明确知道**不能输入（管道模式 / 已结束）时才拦下。
   *
   * ⚠️ `info === null`（第一帧：轮询还没回来）必须**放行** —— 终端实例的创建 `useLayoutEffect`
   * 就在这一刻上报尺寸，此时拦下会回 `true`（「成功」），而 `XtermTerminal` 既有「成功即不再重试」
   * 又有「同尺寸不重复上报」→ 这次上报**永远补不回来**：服务的伪控制台会一直停在创建时的默认
   * 240×50，折行位置与用户看到的终端不一致（全屏程序更明显）。
   * 放行由 Rust 如实回答：真在跑 → `true` 且尺寸当场同步；管道 / 已结束 → `false`，走既有的短重试
   * 后放弃（重试期间 `info` 已到位，开关随即收敛为真实状态）。
   */
  const canResizeRef = useRef(true)
  canResizeRef.current = !info || info.interactive

  /**
   * 传输层：键击出去、尺寸进去（与 `execute_command` 的默认实现同形，只是换成服务自己那三条命令）。
   * 键击不看开关：不可交互时 Rust 一律回 `false`（`XtermTerminal` 静默忽略），多问一句没有副作用。
   */
  const transport = useMemo<PtyTransport>(
    () => ({
      write: (data) => writeServiceConsole(sessionId, serviceId, data),
      resize: (cols, rows) =>
        canResizeRef.current
          ? resizeServiceConsole(sessionId, serviceId, cols, rows)
          : Promise.resolve(true),
    }),
    [sessionId, serviceId],
  )

  const running = !!info?.interactive
  const status = service
    ? serviceStatusLabel(service.status, service.killed)
    : serviceStatusLabel(info?.running ? 'running' : 'exited', false)
  // 状态从「列表」与「控制台」两处取，谁更新用谁：列表负责退出码 / 被杀，控制台负责实时性
  const runningNow = service ? service.status === 'running' : !!info?.running

  // 底部提示：一个问题一行（没有问题时整条不渲染）
  const hints: string[] = []
  if (gone) {
    hints.push(t('该服务已不在列表中（可能已被 AI 终止并清理）'))
  } else if (!info) {
    hints.push(t('正在连接终端…'))
  } else if (!info.terminal) {
    hints.push(t('当前平台不支持交互输入，只能查看输出'))
  } else if (!info.running) {
    hints.push(t('服务已结束，只能查看输出'))
  }
  if (info?.headDropped) {
    hints.push(t('更早的输出已被截断'))
  }

  return (
    <div className="service-console-pane" aria-label={t('服务终端')}>
      <div className="service-console-head">
        {/* 左侧只留身份（名字 + 沙盒）：状态与动作同属一组，一起靠右 */}
        <span className="service-console-name">{service?.name ?? name}</span>
        <SandboxBadge kind={service?.sandbox} />
        <span className="service-spacer" />
        <span className={`service-status is-on-dark ${status.className}`}>
          {status.label}
        </span>
        {runningNow && service && (
          <button
            type="button"
            className="service-console-kill"
            disabled={killing === service.id}
            onClick={() => void kill(sessionId, service)}
            title={tpl('终止 $__name__', { name: service.name })}>
            ■ {killing === service.id ? t('终止中') : t('终止')}
          </button>
        )}
        <button
          type="button"
          className="service-console-close"
          onClick={onClose}
          title={t('关闭')}
          aria-label={t('关闭')}>
          ✕
        </button>
      </div>

      {service?.cmd && (
        <div className="service-console-cmd">$ {service.cmd}</div>
      )}

      <div className="service-console-meta">
        {sessionLabel && (
          <span className="service-console-session">
            {tpl('对话：$__name__', { name: sessionLabel })}
          </span>
        )}
        <span>{tpl('服务 ID：$__id__', { id: serviceId })}</span>
        {service && <span>{tpl('进程 $__pid__', { pid: service.pid })}</span>}
        {service &&
          (service.status === 'running'
            ? service.uptime && (
                <span>{tpl('已运行 $__uptime__', { uptime: service.uptime })}</span>
              )
            : service.returnCode != null && (
                <span>
                  {tpl('退出码 $__code__', { code: service.returnCode })}
                </span>
              ))}
      </div>

      {/* 终端本体：`running` 只控制「能否输入 / 是否显示光标」，内容始终完整渲染（含已结束的） */}
      <XtermTerminal
        stream={stream}
        running={running}
        toolCallId={`${sessionId}:${serviceId}`}
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
