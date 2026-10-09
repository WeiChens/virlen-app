import { t, tpl } from '@/ui/i18n'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { SandboxBadge } from './SandboxBadge'
import { serviceStatusLabel } from './service-status'
import { processTerminalOutput } from '@/infrastructure/tools/execute/common'

/**
 * 后台服务四个工具共用的卡片（`start_background_service` / `get_...` / `kill_...` / `list_...`）。
 *
 * 展示口径（照用户要求）：「启动的命令」+「等待窗口里收到的输出」——
 * 不做面板、不订阅运行中事件（工具返回后输出只进 Rust 缓冲区，靠 get 工具取）。
 * 面板（标题栏入口，P2）另在 `components/service/`，两侧共用 `service-status.ts` 的状态映射。
 *
 * 数据来源只有一处：工具结果的 `uiData`（Rust 组装，语言无关）。界面文案在这里按当前语言重建，
 * 模型侧英文报告不参与渲染（铁律 1）。
 *
 * 状态 → 徽标：见 `./service-status`（与面板共用，取值契约见 Rust `service/common.rs::status`）。
 */

/** 一个服务的详情块（start / get / kill 共用）。 */
function ServiceDetail({ ui }: { ui: Record<string, any> }) {
  const status = serviceStatusLabel(ui.status, ui.killed)
  const stdout = typeof ui.stdout === 'string' ? ui.stdout : ''
  const stderr = typeof ui.stderr === 'string' ? ui.stderr : ''
  const output = [
    stdout ? processTerminalOutput(stdout) : '',
    stderr ? `${t('[标准错误]')}\n${processTerminalOutput(stderr)}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="service-view">
      <div className="service-head">
        <span className={`service-status ${status.className}`}>{status.label}</span>
        {ui.name && <span className="service-name">{String(ui.name)}</span>}
        <SandboxBadge kind={ui.sandbox} />
      </div>
      {ui.cmd && <div className="service-cmd">$ {String(ui.cmd)}</div>}
      <div className="service-meta">
        {ui.id && <span>{tpl('服务 ID：$__id__', { id: String(ui.id) })}</span>}
        {!!ui.pid && <span>{tpl('进程 $__pid__', { pid: String(ui.pid) })}</span>}
        {ui.uptime && (
          <span>{tpl('已运行 $__uptime__', { uptime: String(ui.uptime) })}</span>
        )}
        {ui.returnCode != null && (
          <span>{tpl('退出码 $__code__', { code: String(ui.returnCode) })}</span>
        )}
        {!!ui.unreadChars && (
          <span>{tpl('未读输出 $__n__ 字符', { n: String(ui.unreadChars) })}</span>
        )}
        {ui.waitedMs != null && ui.waitedMs > 0 && (
          <span>{tpl('等待 $__ms__ms 内的输出', { ms: String(ui.waitedMs) })}</span>
        )}
      </div>
      <pre className="service-output">
        {output || t('暂无输出')}
        {ui.truncated ? `\n${t('（输出过长，已截断）')}` : ''}
      </pre>
    </div>
  )
}

/** 列表块（list 工具）。 */
function ServiceList({ services }: { services: any[] }) {
  if (!services.length) {
    return <div className="service-empty">{t('本会话暂无后台服务')}</div>
  }
  return (
    <div className="service-list">
      {services.map((s: Record<string, any>) => {
        const status = serviceStatusLabel(s.status, s.killed)
        return (
          <div className="service-list-row" key={String(s.id)}>
            <span className={`service-status ${status.className}`}>
              {status.label}
            </span>
            <span className="service-list-name">{String(s.name ?? '')}</span>
            <span className="service-list-cmd">{String(s.cmd ?? '')}</span>
            <span className="service-list-meta">
              {tpl('$__id__ · 已运行 $__uptime__', {
                id: String(s.id ?? ''),
                uptime: String(s.uptime ?? ''),
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

class BackgroundServiceMessage implements IToolCallMessage {
  getToolName(): string {
    return 'start_background_service'
  }
  getToolLabel(type: string): string {
    switch (type) {
      case 'get_background_service':
        return t('查看后台服务')
      case 'kill_background_service':
        return t('终止后台服务')
      case 'list_background_services':
        return t('列出后台服务')
      default:
        return t('启动后台服务')
    }
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const { name, cmd, id } = props.useContent.input
      if (props.useContent.name === 'list_background_services') {
        return t('本会话的后台服务')
      }
      if (props.useContent.name === 'start_background_service') {
        return (
          <span className="execute-command-short">
            {name && <span className="execute-command-tips">{name}</span>}
            <span style={{ color: 'var(--accent-color)', fontWeight: 500 }}>
              {cmd}
            </span>
          </span>
        )
      }
      return <span className="service-id-short">{String(id ?? '')}</span>
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if(!props.expand){
      return <></>
    }
    try {
      const ui = props.message?.uiData as Record<string, any> | undefined
      // 运行中（工具还没返回）：先只显示命令，等结果里带 uiData 再渲染详情
      if (!ui) {
        const { name, cmd } = props.useContent.input
        if (props.useContent.name === 'list_background_services') {
          return <div className="service-pending">{t('查询中…')}</div>
        }
        return (
          <div className="service-view">
            <div className="service-head">
              <span className="service-status is-pending">{t('启动中…')}</span>
              {name && <span className="service-name">{String(name)}</span>}
            </div>
            {cmd && <div className="service-cmd">$ {String(cmd)}</div>}
          </div>
        )
      }
      if (Array.isArray(ui.services)) {
        return <ServiceList services={ui.services} />
      }
      if (!ui.id && ui.status === 'failed') {
        // spawn 就失败：没有 pid / 输出，只有一句错误
        return (
          <div className="service-view">
            <div className="service-head">
              <span className="service-status is-failed">{t('启动失败')}</span>
              {ui.name && <span className="service-name">{String(ui.name)}</span>}
            </div>
            {ui.cmd && <div className="service-cmd">$ {String(ui.cmd)}</div>}
            {ui.error && <pre className="service-output">{String(ui.error)}</pre>}
          </div>
        )
      }
      return <ServiceDetail ui={ui} />
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return true
  }
}

export default BackgroundServiceMessage
