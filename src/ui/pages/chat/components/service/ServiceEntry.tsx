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
 * 点任意一行 → 上报 `onOpenService`，由宿主在**右侧面板**开一个服务终端标签（运行中的能敲键盘，
 * 已结束的只读回放）。入口不再持有终端：标签归面板容器，切会话 / 关标签的语义都在那边，一份就够。
 *
 * P4（`sessionId === null` = 聊天页处于「新对话」）：同一套面板切到**全局视图** —— 列出所有会话的
 * 服务、每行标出归属会话（标题优先，查不到退回 id）。服务是活进程，切到新对话页也不能「找不到」；
 * 打开终端 / 终止都带上**行自己的**会话 id（跨会话操作是用户显式点击的结果）。
 */
import { useEffect, useRef, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import ServerSvg from '@/ui/components/icons/ServerSvg'
import { sessionStore } from '@/ui/store'
import { type BackgroundServiceInfo } from '@/infrastructure/backgroundService'
import { SandboxBadge } from '../tool-call/SandboxBadge'
import { serviceStatusLabel } from '../tool-call/service-status'
import { useServiceKill } from './use-service-kill'
import { useServiceList } from './use-service-list'
import './style.scss'

/** 宿主（右侧面板）要开哪个服务终端；会话 id 在**点击那一刻**定死，标签从此只认这一路终端 */
export interface ServiceTabTarget {
  sessionId: string
  serviceId: string
  /** 标签标题（服务名） */
  name: string
  /** 归属会话标签（只有新对话页的全局视图才传；本会话视图就是当前会话，画出来只占宽） */
  sessionLabel?: string
}

interface Props {
  /** 归属会话；`null` = 聊天页处于「新对话」（未选中会话）→ **全局视图**（列出所有会话的服务） */
  sessionId: string | null
  /** 点服务行 → 在右侧面板打开它的终端标签 */
  onOpenService: (target: ServiceTabTarget) => void
}

/** 会话标签：标题优先，查不到（已删除 / 未加载）退回 id —— 全局视图里每行都要说得清「这条是谁的」 */
function sessionLabelOf(sessionId: string): string {
  return sessionStore.getSession(sessionId)?.title || sessionId
}

/**
 * 一行：状态 + 名称 + 终止按钮 / 命令 / 元信息（进程、时长、未读输出、沙盒）。
 *
 * 整行可点 → 打开终端标签；行内「终止」按钮要 `stopPropagation`，
 * 否则一点就把「杀服务」和「开终端」同时干了。
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

export default function ServiceEntry({ sessionId, onOpenService }: Props) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'running' | 'exited'>('running')
  const wrapRef = useRef<HTMLDivElement>(null)
  /** 全局视图（新对话页）才显示归属会话 */
  const globalView = sessionId === null
  const { services, refresh } = useServiceList(sessionId, open)
  const { killing, kill } = useServiceKill(refresh)

  const running = services.filter((s) => s.status === 'running')
  const exited = services.filter((s) => s.status !== 'running')
  const rows = tab === 'running' ? running : exited

  // 条目全没了（AI 把最后一条 kill 掉并清出了注册表）→ 入口收起来；浮层跟着关，
  // 否则下次有服务时它会自己弹开
  useEffect(() => {
    if (!services.length) setOpen(false)
  }, [services.length])

  // 换会话：浮层收起 —— 列表本身按会话轮询，留着浮层只会展示上一个会话的行
  useEffect(() => {
    setOpen(false)
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

  /** 终止一个服务：全局视图里用**行自己的**会话 id；本会话视图的行不带 sessionId → 回落到入口的会话 */
  const handleKill = (svc: BackgroundServiceInfo) => {
    const sid = svc.sessionId ?? sessionId
    if (!sid) return
    void kill(sid, svc)
  }

  /** 打开终端标签：顺手收起浮层（标签一开就占走右半边，浮层留着只挡路）。会话 id 随行固定。 */
  const handleOpen = (svc: BackgroundServiceInfo) => {
    const sid = svc.sessionId ?? sessionId
    if (!sid) return
    setOpen(false)
    onOpenService({
      sessionId: sid,
      serviceId: svc.id,
      name: svc.name,
      // 本会话视图不传：面板里那条 meta 与入口一样，不必重复写「会话：当前会话」
      sessionLabel: globalView ? sessionLabelOf(sid) : undefined,
    })
  }

  // 一条服务都没有 → 入口整个不渲染（与任务清单入口同一口径）
  if (!services.length) return null

  return (
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
  )
}
