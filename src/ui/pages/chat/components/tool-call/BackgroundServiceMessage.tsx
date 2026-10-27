import { t, tpl } from '@/ui/i18n'
import commentEvent from '@/events/commentEvent'
import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import { processTerminalOutput } from '@/infrastructure/tools/execute/common'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { SandboxBadge } from './SandboxBadge'
import { serviceStatusLabel } from './service-status'
import { XtermTerminalBlock } from './XtermTerminal'

/**
 * 后台服务四个工具共用的卡片（`start_background_service` / `get_...` / `kill_...` / `list_...`）。
 *
 * 展示口径（照用户要求）：「启动的命令」+「工具返回那一刻窗口里的输出」——
 * 不做面板、不订阅运行中事件（工具返回后输出只进 Rust 缓冲区，靠 get 工具取）。
 * 面板（标题栏入口，P2）另在 `components/service/`，两侧共用 `service-status.ts` 的状态映射。
 *
 * 输出**交给 xterm 渲染**，不再走 `<pre>` + 去色：服务输出往往是带 ANSI 的日志 / 进度条，
 * 去色后既丢颜色又丢 `\r` 覆盖；而 xterm 就是命令终端用的那个组件 —— 这里给
 * `XtermTerminalBlock` 传 `running=false`（只读回放），全屏 / 选中复制 / 右键菜单一并继承（铁律 1）。
 *
 * 数据来源只有一处：工具结果的 `uiData`（Rust 组装，语言无关）。界面文案在这里按当前语言重建，
 * 模型侧英文报告不参与渲染（铁律 1）。
 *
 * 状态 → 徽标：见 `./service-status`（与面板共用，取值契约见 Rust `service/common.rs::status`）。
 */

/** 一个服务在卡片里要渲染的全部字段（`uiData`；旧消息 / 失败路径可能缺字段，一律按空处理） */
type ServiceUi = Record<string, any>

/**
 * 回放给终端的原始流：stdout + stderr **原样**拼接，一个字节都不改。
 *
 * 为什么不去色 / 不预先解析：`\r` 覆盖（进度条）与 ANSI 配色必须由终端自己算，预处理过的文本
 * 塞进 xterm 只会看到「重绘痕迹」和「颜色丢失」。两个流在后端是分开的缓冲，交织顺序在采集时
 * 就已经丢了 —— 所以用一行**亮红标记**交代边界（标记走 i18n，与模型侧固定英文的 `[stderr]` 无关）。
 */
export function replayStream(ui: ServiceUi): string {
  const stdout = typeof ui.stdout === 'string' ? ui.stdout : ''
  const stderr = typeof ui.stderr === 'string' ? ui.stderr : ''
  if (!stderr) return stdout
  const mark = `\x1b[91m${t('[标准错误]')}\x1b[0m\r\n`
  // stdout 没以换行收尾时补一个，否则标记会粘在最后一行日志后面
  if (!stdout) return mark + stderr
  return `${stdout}${stdout.endsWith('\n') ? '' : '\r\n'}${mark}${stderr}`
}

/**
 * 打开这个服务的终端标签（右侧面板，运行中能敲键盘 / 已结束只读回放）。
 *
 * 面板状态归 `chat-view` 一家所有（`panelBuckets`），卡片只上报「哪一个服务」——
 * 会话 id 由宿主按当前会话补齐（卡片不知道自己被哪一桶渲染）。
 */
function openServiceTerminal(ui: ServiceUi): void {
  if (!ui.id) return
  commentEvent.emit('openServiceTerminal', {
    serviceId: String(ui.id),
    name: String(ui.name ?? ''),
  })
}

/** 元信息行（终端窗口命令行下方那一条）：服务 ID / 进程 / 运行时长 / 退出码 / 未读 / 等待窗口 */
function ServiceMeta({ ui }: { ui: ServiceUi }) {
  return (
    <>
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
    </>
  )
}

/** 卡片标题栏右侧的两个动作：打开终端 / 复制全部输出（复制成**纯文本**，不带 ANSI） */
function ServiceActions({ ui, stream }: { ui: ServiceUi; stream: string }) {
  if (!ui.id) return null
  return (
    <>
      <button
        type="button"
        className="terminal-ctl-btn"
        title={t('打开终端')}
        onClick={() => openServiceTerminal(ui)}>
        {t('打开终端')}
      </button>
      <button
        type="button"
        className="terminal-ctl-btn"
        title={t('复制全部输出')}
        onClick={() => {
          // 终端里看得见的是「渲染后」的画面，剪贴板要的是能贴进别处的纯文本 → 过一遍去色 / \r 覆盖
          void copyText(processTerminalOutput(stream)).then((ok) => {
            if (!ok) showToast(t('复制失败'))
          })
        }}>
        {t('复制')}
      </button>
    </>
  )
}

/** 服务详情（start / get / kill 共用）：终端窗口 = 状态 + 名称 + 命令 + 元信息 + 输出 */
function ServiceCard({ ui, toolCallId }: { ui: ServiceUi; toolCallId: string }) {
  const status = serviceStatusLabel(ui.status, ui.killed)
  const stream = replayStream(ui)
  return (
    <XtermTerminalBlock
      title={String(ui.name ?? '')}
      cmd={ui.cmd ? String(ui.cmd) : undefined}
      sandbox={ui.sandbox}
      head={
        <>
          <span className={`service-status is-on-dark ${status.className}`}>
            {status.label}
          </span>
          {ui.name && (
            <span className="service-card-name">{String(ui.name)}</span>
          )}
        </>
      }
      meta={<ServiceMeta ui={ui} />}
      actions={<ServiceActions ui={ui} stream={stream} />}
      stream={stream}
      running={false}
      toolCallId={toolCallId}
      // 空输出时说一句「暂无输出」：一块纯黑的终端看着像渲染坏了
      note={stream.trim() ? undefined : t('暂无输出')}
    />
  )
}

/** 运行中（工具还没返回）：同一套终端窗口，先把命令摆出来，等结果里带 uiData 再换详情 */
function ServicePending({
  name,
  cmd,
  toolCallId,
}: {
  name?: string
  cmd?: string
  toolCallId: string
}) {
  return (
    <XtermTerminalBlock
      title={name ?? ''}
      cmd={cmd}
      head={
        <>
          <span className="service-status is-on-dark is-pending">
            {t('启动中…')}
          </span>
          {name && <span className="service-card-name">{name}</span>}
        </>
      }
      stream=""
      running={false}
      toolCallId={toolCallId}
      note={t('正在等待输出…')}
    />
  )
}

/**
 * 浅色错误卡片（不是终端画面）：没有 pid、没有输出，只有一句错误。
 *
 * 两个来源：① spawn 就失败（连 shell 都没起来）；② **工具已返回但结果里没有 `uiData`**
 * （调用级异常 / 旧消息）—— 这两种都不能套一个空终端：黑屏 + 「启动中…」会被读成「还在起」。
 */
function ServiceErrorCard({
  name,
  cmd,
  sandbox,
  label,
  body,
}: {
  name?: string
  cmd?: string
  sandbox?: string
  label: string
  body?: string
}) {
  return (
    <div className="service-view">
      <div className="service-head">
        <span className="service-status is-failed">{label}</span>
        {name && <span className="service-name">{name}</span>}
        <SandboxBadge kind={sandbox} />
      </div>
      {cmd && <div className="service-cmd">$ {cmd}</div>}
      {body && <pre className="service-output">{body}</pre>}
    </div>
  )
}

/** 列表块（list 工具）：一个服务一行 —— 状态 / 名称 / 命令 / 标识与时长 / 打开终端 */
function ServiceList({ services }: { services: ServiceUi[] }) {
  if (!services.length) {
    return <div className="service-empty">{t('本对话暂无后台服务')}</div>
  }
  return (
    <div className="service-list">
      {services.map((s) => {
        const status = serviceStatusLabel(s.status, s.killed)
        return (
          <div className="service-list-row" key={String(s.id)}>
            <span className={`service-status ${status.className}`}>
              {status.label}
            </span>
            <span className="service-list-name">{String(s.name ?? '')}</span>
            <span className="service-list-cmd" title={String(s.cmd ?? '')}>
              {String(s.cmd ?? '')}
            </span>
            <span className="service-list-meta">
              <span>
                {tpl('服务 ID：$__id__', { id: String(s.id ?? '') })}
              </span>
              {s.status === 'running'
                ? s.uptime && (
                    <span>
                      {tpl('已运行 $__uptime__', { uptime: String(s.uptime) })}
                    </span>
                  )
                : s.returnCode != null && (
                    <span>
                      {tpl('退出码 $__code__', { code: String(s.returnCode) })}
                    </span>
                  )}
            </span>
            {s.id && (
              <button
                type="button"
                className="service-list-open"
                title={t('打开终端')}
                onClick={() => openServiceTerminal(s)}>
                {t('打开终端')}
              </button>
            )}
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
        return t('本对话的后台服务')
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
    if (!props.expand) {
      return <></>
    }
    try {
      const ui = props.message?.uiData as ServiceUi | undefined
      // xterm 实例按工具调用 id 建（一条工具消息一块终端：换消息 = 换屏，不跨条复用 scrollback）
      const toolCallId = props.useContent.id
      const input = props.useContent.input
      // 工具还没返回：先只显示命令，等结果里带 uiData 再渲染详情
      if (!ui) {
        if (props.useContent.name === 'list_background_services') {
          return <div className="service-pending">{t('查询中…')}</div>
        }
        // 已经返回却没有 uiData（调用级异常 / 旧消息）：如实把结果正文当错误报出来，
        // 不能继续画「启动中」—— 那会让用户一直等在一条已经结束的工具上
        if (props.message) {
          const body = props.message.content
          return (
            <ServiceErrorCard
              name={input.name ? String(input.name) : undefined}
              cmd={input.cmd ? String(input.cmd) : undefined}
              label={t('失败')}
              body={typeof body === 'string' ? body : undefined}
            />
          )
        }
        return (
          <ServicePending
            name={input.name ? String(input.name) : undefined}
            cmd={input.cmd ? String(input.cmd) : undefined}
            toolCallId={toolCallId}
          />
        )
      }
      if (Array.isArray(ui.services)) {
        return <ServiceList services={ui.services} />
      }
      if (!ui.id && ui.status === 'failed') {
        return (
          <ServiceErrorCard
            name={ui.name ? String(ui.name) : undefined}
            cmd={ui.cmd ? String(ui.cmd) : undefined}
            sandbox={ui.sandbox}
            label={t('启动失败')}
            body={ui.error ? String(ui.error) : undefined}
          />
        )
      }
      return <ServiceCard ui={ui} toolCallId={toolCallId} />
    } catch {
      return <div className="error">{t('解析异常')}</div>
    }
  }
  diyWrapper(): boolean {
    return true
  }
}

export default BackgroundServiceMessage
