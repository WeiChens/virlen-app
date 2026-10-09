/**
 * ServiceEntry — 聊天页标题栏的「后台服务」入口（按钮 + 运行中徽标 + 面板浮层，P2）。
 *
 * 数据来源只有一处：Rust 注册表（`cmd_list_background_services`）。面板与四个 `*_background_service`
 * 工具看的是**同一张表**，所以这里既能看到 AI 起的服务，也能就地终止它（模型下一次 `get` 会如实
 * 看到「被终止」）。
 *
 * - 入口只在「有服务」时出现（与任务清单入口同一口径）：已选中会话时看**本会话**，新对话页看
 *   **全部会话**（P4）；徽标 = **运行中**数量（用户口径：还有东西在跑吗），已结束但还在表里的
 *   条目不算 —— 但只要还有条目，入口就留着（否则用户没法看那些已结束的输出）；
 * - 分「运行中 / 已结束」两页，默认运行中；条数直接挂在页签上，用户一眼知道另一页有没有东西；
 * - 终止 = 直接杀（用户要求不弹二次确认）；「已结束」页的行没有按钮 —— 幂等语义留给 AI 的 kill 工具。
 *
 * P3：点任意一行打开**终端弹窗**（`ServiceTerminal`）—— 运行中的能敲键盘，已结束的只读回放。
 * 弹窗由本组件持有（portal 到 body）；本会话条目被清空时入口收起，弹窗也就随之卸载。
 *
 * P4（`sessionId === null` = 聊天页处于「新对话」）：同一套面板切到**全局视图** —— 列出所有会话的
 * 服务、每行标出归属会话（标题优先，查不到退回 id）。服务是活进程，切到新对话页也不能「找不到」；
 * 终止 / 终端弹窗都带上**行自己的**会话 id（跨会话操作是用户显式点击的结果）。
 */
import { useEffect, useRef, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import ServerSvg from '@/ui/components/icons/ServerSvg'
import { showToast } from '@/ui/components/shared/Toast'
import { sessionStore } from '@/ui/store'
import {
  killBackgroundService,
  type BackgroundServiceInfo,
} from '@/infrastructure/backgroundService'
import { SandboxBadge } from '../tool-call/SandboxBadge'
import { serviceStatusLabel } from '../tool-call/service-status'
import ServiceTerminal from './ServiceTerminal'
import { useServiceList } from './use-service-list'
import './style.scss'

interface Props {
  /** 归属会话；`null` = 聊天页处于「新对话」（未选中会话）→ **全局视图**（列出所有会话的服务） */
  sessionId: string | null
}

/** 会话标签：标题优先，查不到（已删除 / 未加载）退回 id —— 全局视图里每行都要说得清「这条是谁的」 */
function sessionLabelOf(sessionId: string): string {
  return sessionStore.getSession(sessionId)?.title || sessionId
}

/**
 * 一行：状态 + 名称 + 终止按钮 / 命令 / 元信息（进程、时长、未读输出、沙盒）。
 *
 * 整行可点 → 打开终端弹窗（P3）；行内「终止」按钮要 `stopPropagation`，
 * 否则一点就把「杀服务」和「开弹窗」同时干了。
 */
function ServiceRow({
  service,
  sessionLabel,
  killing,
  onKill,
  onOpen,
}: {
  service: BackgroundServiceInfo
  /** 归属会话（只在全局视图里传）：行头上的小徽标 */
  sessionLabel?: string
  killing: boolean
  onKill: (s: BackgroundServiceInfo) => void
  onOpen: (s: BackgroundServiceInfo) => void
}) {
  const status = serviceStatusLabel(service.status, service.killed)
  // 「已运行」只在活着时显示：死掉之后 `uptime` 只是「距启动多久」，写出来会被读成运行了这么久
  const running = service.status === 'running'

  return (
    <div
      className="service-row is-clickable"
      role="button"
      tabIndex={0}
      title={t('打开终端')}
      onClick={() => onOpen(service)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(service)
        }
      }}>
      <div className="service-row-head">
        <span className={`service-status ${status.className}`}>{status.label}</span>
        <span className="service-row-name" title={service.name}>
          {service.name}
        </span>
        {/* 归属会话（全局视图才有）：本会话视图不显示 —— 就是当前会话，画出来只占宽 */}
        {sessionLabel && (
          <span className="service-row-session" title={sessionLabel}>
            {tpl('会话：$__name__', { name: sessionLabel })}
          </span>
        )}
        <span className="service-spacer" />
        {running && (
          <button
            type="button"
            className="service-kill-btn"
            disabled={killing}
            onClick={(e) => {
              e.stopPropagation()
              onKill(service)
            }}
            title={tpl('终止 $__name__', { name: service.name })}>
            {killing ? t('终止中') : t('终止')}
          </button>
        )}
      </div>
      <div className="service-row-cmd" title={service.cmd}>
        $ {service.cmd}
      </div>
      <div className="service-row-meta">
        <span>{tpl('服务 ID：$__id__', { id: service.id })}</span>
        <span>{tpl('进程 $__pid__', { pid: service.pid })}</span>
        {running
          ? service.uptime && (
              <span>{tpl('已运行 $__uptime__', { uptime: service.uptime })}</span>
            )
          : service.returnCode != null && (
              <span>{tpl('退出码 $__code__', { code: service.returnCode })}</span>
            )}
        {service.unreadChars > 0 && (
          <span>{tpl('未读输出 $__n__ 字符', { n: service.unreadChars })}</span>
        )}
        <SandboxBadge kind={service.sandbox} />
      </div>
    </div>
  )
}

export default function ServiceEntry({ sessionId }: Props) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'running' | 'exited'>('running')
  const [killing, setKilling] = useState<string | null>(null)
  /**
   * 终端弹窗看着哪个服务（`null` = 没开）；用 id 而不是整行快照，弹窗头部才能跟着轮询刷新。
   * 会话 id 在**打开那一刻固定**：全局视图里那一行可能被清出列表，弹窗还要继续轮询报「已不在表中」。
   */
  const [terminalOf, setTerminalOf] = useState<{
    sessionId: string
    id: string
  } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  /** 全局视图（新对话页）才显示归属会话 */
  const globalView = sessionId === null
  // 弹窗开着时也保持快节奏：弹窗头部（状态 / 运行时长 / 退出码）与面板共用同一份数据
  const { services, refresh } = useServiceList(sessionId, open || !!terminalOf)

  const running = services.filter((s) => s.status === 'running')
  const exited = services.filter((s) => s.status !== 'running')
  const rows = tab === 'running' ? running : exited
  const terminalService = terminalOf
    ? services.find((s) => s.id === terminalOf.id)
    : undefined

  // 条目全没了（AI 把最后一条 kill 掉并清出了注册表）→ 入口收起来；浮层跟着关，
  // 否则下次有服务时它会自己弹开
  useEffect(() => {
    if (!services.length) setOpen(false)
  }, [services.length])

  // 换会话：浮层与终端弹窗都收起 —— 服务是**会话内**的，留着弹窗只会去查上一个会话的 id
  useEffect(() => {
    setOpen(false)
    setTerminalOf(null)
  }, [sessionId])

  // 点击浮层外部关闭（与任务清单浮层同一口径：mousedown 判断包含关系）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  /** 终止一个服务：直接杀，不弹二次确认（用户要求）；结果如实回报，不谎报成功。 */
  const handleKill = async (svc: BackgroundServiceInfo) => {
    // 全局视图里用**行自己的**会话 id；本会话视图的行不带 sessionId → 回落到入口的会话
    const sid = svc.sessionId ?? sessionId
    if (!sid) return
    setKilling(svc.id)
    try {
      const row = await killBackgroundService(sid, svc.id)
      if (!row) {
        // 不在表里了（多半是 AI 刚 kill 掉并清出注册表）
        showToast(t('该服务已不在列表中'))
      } else if (row.status === 'running') {
        // 发了信号但没等到退出 —— 如实说，下一次轮询会把真实状态带回来
        showToast(
          tpl('已向 $__name__ 发出终止信号，尚未确认退出', { name: row.name }),
        )
      } else {
        showToast(tpl('已终止 $__name__', { name: row.name }))
      }
      await refresh()
    } catch (e: any) {
      showToast(`${t('操作失败')}：${e?.message || String(e)}`)
      await refresh()
    } finally {
      setKilling(null)
    }
  }

  /** 打开终端弹窗：顺手收起浮层（弹窗要占满视线，浮层留着只挡路）。会话 id 随行固定。 */
  const handleOpen = (svc: BackgroundServiceInfo) => {
    const sid = svc.sessionId ?? sessionId
    if (!sid) return
    setOpen(false)
    setTerminalOf({ sessionId: sid, id: svc.id })
  }

  // 一条服务都没有、也没开着弹窗 → 入口整个不渲染（与任务清单入口同一口径）
  if (!services.length && !terminalOf) return null

  return (
    <>
      {services.length > 0 && (
        <div className="service-entry" ref={wrapRef}>
          <button
            type="button"
            className={`toolbar-icon-btn service-entry-btn ${open ? 'active' : ''}`}
            onClick={() => setOpen((v) => !v)}
            title={
              running.length
                ? tpl('后台服务：$__n__ 个运行中', { n: running.length })
                : t('后台服务')
            }>
            <ServerSvg />
            {running.length > 0 && (
              <span className="service-badge">
                {running.length > 99 ? '99+' : running.length}
              </span>
            )}
          </button>

          {open && (
            <div className="service-popover">
              <div className="service-popover-head">
                <span className="service-popover-title">{t('后台服务')}</span>
                {/* 可见范围提示：已选会话 = 本会话（与工具同一张表）；新对话页 = 全部会话 */}
                <span className="service-scope">
                  {globalView ? t('全部会话') : t('仅本会话')}
                </span>
                <span className="service-spacer" />
                <button
                  type="button"
                  className="service-close"
                  onClick={() => setOpen(false)}
                  title={t('关闭')}>
                  ✕
                </button>
              </div>

              <div className="service-tabs">
                <button
                  type="button"
                  className={`service-tab ${tab === 'running' ? 'active' : ''}`}
                  onClick={() => setTab('running')}>
                  {t('运行中')}
                  <span className="service-tab-count">{running.length}</span>
                </button>
                <button
                  type="button"
                  className={`service-tab ${tab === 'exited' ? 'active' : ''}`}
                  onClick={() => setTab('exited')}>
                  {t('已结束')}
                  <span className="service-tab-count">{exited.length}</span>
                </button>
              </div>

              <div className="service-rows">
                {rows.length === 0 ? (
                  <div className="service-panel-empty">
                    {tab === 'running'
                      ? t('暂无运行中的后台服务')
                      : t('暂无已结束的后台服务')}
                  </div>
                ) : (
                  rows.map((s) => (
                    <ServiceRow
                      key={s.id}
                      service={s}
                      sessionLabel={
                        globalView && s.sessionId
                          ? sessionLabelOf(s.sessionId)
                          : undefined
                      }
                      killing={killing === s.id}
                      onKill={handleKill}
                      onOpen={handleOpen}
                    />
                  ))
                )}
              </div>

              {tab === 'exited' && exited.length > 0 && (
                <div className="service-foot">
                  {t('已结束的服务仍可被 AI 读取输出；下次启动新服务时会自动清理')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {terminalOf && (
        <ServiceTerminal
          sessionId={terminalOf.sessionId}
          serviceId={terminalOf.id}
          service={terminalService}
          sessionLabel={
            globalView ? sessionLabelOf(terminalOf.sessionId) : undefined
          }
          killing={killing === terminalOf.id}
          onKill={handleKill}
          onClose={() => setTerminalOf(null)}
        />
      )}
    </>
  )
}
