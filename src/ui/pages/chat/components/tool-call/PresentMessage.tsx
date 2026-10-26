/**
 * PresentMessage — `present`（交付物）在消息流里的一行。
 *
 * 折叠态：`报告.xlsx +2`；展开态：交付条（文件：图标 / 文件名 / 体积；网址：主机 + 地址），
 * 点一下就在**右侧面板**打开（同路径的标签已存在就只是切过去，草稿不丢）。
 *
 * 与右侧面板的关系：工具结果到达时**自动打开**那一次由事件处理器做
 * （`services/chat/event-handler.ts` + `services/present-service.ts`）；这里只负责
 * 「关掉之后想再看一眼」—— 不必回头再喊 AI 一遍。
 *
 * 网址的点击走 `browser-open-service`（与正文里的链接同一个出口）："这两处开网页"就该是同一条路。
 */
import { openPath } from '@tauri-apps/plugin-opener'
import { t } from '@/ui/i18n'
import FileChip from '@/ui/components/shared/FileChip'
import { revealPresented } from '@/services/present-service'
import { openUrlInSidePanelBrowser } from '@/services/browser-open-service'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 展示用的一个交付文件（uiData.files 的一项；工具还没跑完时退化为入参路径） */
interface PresentedFile {
  path: string
  name?: string
  sizeBytes?: number
}

/** 展示用的一个交付网址（uiData.links 的一项；`name` 是主机） */
interface PresentedLink {
  url: string
  name?: string
}

/** 入参里的路径（`path` / `paths`，与 Rust `requested_paths` 同口径） */
function inputPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const record = input as Record<string, unknown>
  const list: string[] = []
  if (typeof record.path === 'string' && record.path) list.push(record.path)
  if (Array.isArray(record.paths)) {
    list.push(
      ...record.paths.filter((p): p is string => typeof p === 'string' && !!p),
    )
  }
  return list
}

/**
 * 本次要展示的文件。
 *
 * ⚠️ 路径的权威来源是 `uiData`（Rust 侧已解析成绝对路径并做过安全校验）；
 * 入参只在「工具还没执行完」时兜底 —— 那时的路径可能是相对的。
 */
function filesOf(props: ToolMessageProps): PresentedFile[] {
  const ui = props.message?.uiData as { type?: string; files?: unknown } | undefined
  if (ui?.type === 'present' && Array.isArray(ui.files)) {
    return (ui.files as Record<string, unknown>[])
      .filter((file) => typeof file?.path === 'string' && !!file.path)
      .map((file) => ({
        path: file.path as string,
        name: typeof file.name === 'string' ? file.name : undefined,
        sizeBytes:
          typeof file.sizeBytes === 'number' ? (file.sizeBytes as number) : undefined,
      }))
  }
  return inputPaths(props.useContent.input).map((path) => ({ path }))
}

/** 本次要展示的网址（权威来源同样是 `uiData.links`；入参里带 `://` 的兜底进去） */
function linksOf(props: ToolMessageProps): PresentedLink[] {
  const ui = props.message?.uiData as { type?: string; links?: unknown } | undefined
  if (ui?.type === 'present' && Array.isArray(ui.links)) {
    return (ui.links as Record<string, unknown>[])
      .filter((link) => typeof link?.url === 'string' && !!link.url)
      .map((link) => ({
        url: link.url as string,
        name: typeof link.name === 'string' ? link.name : undefined,
      }))
  }
  return inputPaths(props.useContent.input)
    .filter((path) => path.includes('://'))
    .map((url) => ({ url }))
}

/** 被跳过的路径（不存在 / 是目录 / 面板预览不了的类型 / 被安全规则挡下）—— 失败原因按工具原文显示，便于排查 */
function skippedOf(props: ToolMessageProps): { path: string; reason: string }[] {
  const ui = props.message?.uiData as { type?: string; skipped?: unknown } | undefined
  if (ui?.type !== 'present' || !Array.isArray(ui.skipped)) return []
  return (ui.skipped as Record<string, unknown>[])
    .filter((item) => typeof item?.path === 'string' && !!item.path)
    .map((item) => ({
      path: item.path as string,
      reason: typeof item.reason === 'string' ? item.reason : '',
    }))
}

/** 文件名（uiData 没给时从路径末段取，兼容 / 与 \） */
function nameOf(file: PresentedFile): string {
  if (file.name) return file.name
  const parts = file.path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || file.path
}

/**
 * 点文件条 → 右侧面板打开。没有面板宿主时退回系统默认程序 ——
 * 别让一次点击变成「什么都没发生」。
 */
function openInPanel(path: string) {
  if (revealPresented({ paths: [path], urls: [] })) return
  void openPath(path).catch(() => {})
}

/** 点网址条 → 右侧栏网页标签（与正文里的链接同一个出口）；没宿主要退回系统浏览器 */
function openLinkInPanel(url: string) {
  if (openUrlInSidePanelBrowser(url)) return
  void openPath(url).catch(() => {})
}

class PresentMessage implements IToolCallMessage {
  getToolName(): string {
    return 'present'
  }
  getToolLabel(): string {
    return t('交付文件')
  }
  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      const files = filesOf(props)
      const links = linksOf(props)
      if (files.length === 0 && links.length === 0) return t('交付文件')
      // 折叠态只漏一个主交付物：有文件时文件优先（那是主体），否则第一个网址的主机
      const text = files.length > 0 ? nameOf(files[0]) : links[0].name || links[0].url
      const total = files.length + links.length
      return (
        <div className="tool-short-row">
          <span className="tool-short-em">{text}</span>
          {total > 1 && <span className="tool-short-muted">+{total - 1}</span>}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }
  getExpandView(props: ToolMessageProps): React.ReactNode {
    if (props.message?.isError) {
      return <div className="error">{props.message.content as string}</div>
    }
    if (!props.expand) return null

    const files = filesOf(props)
    const links = linksOf(props)
    const skipped = skippedOf(props)
    if (files.length === 0 && links.length === 0 && skipped.length === 0) return null

    return (
      <div className="tool-call-expand-view">
        {files.length > 0 && (
          <div className="present-files">
            {files.map((file) => (
              <FileChip
                key={file.path}
                path={file.path}
                name={file.name}
                size={file.sizeBytes}
                onClick={() => openInPanel(file.path)}
              />
            ))}
          </div>
        )}
        {links.length > 0 && (
          <div className="present-links">
            {links.map((link) => (
              <button
                key={link.url}
                type="button"
                className="present-link"
                // 完整地址放 title：卡片里只留主机（长 URL 会把整行撑开）
                title={link.url}
                onClick={() => openLinkInPanel(link.url)}>
                <span className="present-link-host">{link.name || link.url}</span>
                <span className="present-link-url">{link.url}</span>
              </button>
            ))}
          </div>
        )}
        {skipped.length > 0 && (
          <div className="tool-plain-list">
            {skipped.map((item) => (
              <div key={item.path} className="tool-plain-row">
                <span className="tool-plain-row-icon">⚠</span>
                <span className="tool-plain-row-text">
                  {item.path} — {item.reason}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default PresentMessage
