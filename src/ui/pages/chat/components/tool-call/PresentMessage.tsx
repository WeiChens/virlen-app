/**
 * PresentMessage — `present`（交付物）在消息流里的一行。
 *
 * 折叠态：`报告.xlsx +2`；展开态：文件条（图标 / 文件名 / 体积），点一下就在**右侧面板**打开
 * （同路径的标签已存在就只是切过去，草稿不丢）。
 *
 * 与右侧面板的关系：工具结果到达时**自动打开**那一次由事件处理器做
 * （`services/chat/event-handler.ts` + `services/present-service.ts`）；这里只负责
 * 「关掉之后想再看一眼」—— 不必回头再喊 AI 一遍。
 */
import { openPath } from '@tauri-apps/plugin-opener'
import { t } from '@/ui/i18n'
import FileChip from '@/ui/components/shared/FileChip'
import { revealPresentedFiles } from '@/services/present-service'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 展示用的一个交付文件（uiData.files 的一项；工具还没跑完时退化为入参路径） */
interface PresentedFile {
  path: string
  name?: string
  sizeBytes?: number
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
  if (revealPresentedFiles([path])) return
  void openPath(path).catch(() => {})
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
      if (files.length === 0) return t('交付文件')
      return (
        <div className="tool-short-row">
          <span className="tool-short-em">{nameOf(files[0])}</span>
          {files.length > 1 && (
            <span className="tool-short-muted">+{files.length - 1}</span>
          )}
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
    const skipped = skippedOf(props)
    if (files.length === 0 && skipped.length === 0) return null

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
