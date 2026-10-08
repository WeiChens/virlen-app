/**
 * read_file —— 单文件是一个代码块；多文件是「一个代码块 + 文件名下拉」。
 *
 * 多文件原先给每个文件各挂一个 CodeBlock（N 个块纵向堆叠）：长文件把消息拉得极长，而且
 * 要读每个块的头才知道是哪个文件。现在只留一个块，文件名换成下拉（Select），点它切换 ——
 * 切换只改 props（fileName / children / actions），CodeBlock 的全屏态与 Monaco 实例都保留。
 */
import { useState } from 'react'
import { t } from '@/ui/i18n'
import { getFileParentDir, getUrlFileName, toShortPath } from '@/utils/common'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import CodeBlock, { type Action } from '../message/code-block'
import Select from '@/ui/components/shared/Select'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'
import { editorService } from '@/services/editor-service'
import { openPath } from '@tauri-apps/plugin-opener'
import FolderSvg from '@/ui/components/icons/FolderSvg'

/** uiData.files 的一项（字段见 infrastructure/tools/file/read-file.ts::readSingleFile） */
interface ReadFileEntry {
  content?: string
  fullPath?: string
  startLine?: number
  endLine?: number
}

/** 「编辑器打开」图标 */
function EditorOpenSvg() {
  return (
    <svg
      viewBox="0 0 1024 1024"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200">
      <path
        d="M438.4 849.1l222.7-646.7c0.2-0.5 0.3-1.1 0.4-1.6L438.4 849.1z"
        opacity=".224"></path>
      <path d="M661.2 168.7h-67.5c-3.4 0-6.5 2.2-7.6 5.4L354.7 846c-0.3 0.8-0.4 1.7-0.4 2.6 0 4.4 3.6 8 8 8h67.8c3.4 0 6.5-2.2 7.6-5.4l0.7-2.1 223.1-648.3 7.4-21.4c0.3-0.8 0.4-1.7 0.4-2.6-0.1-4.5-3.6-8.1-8.1-8.1zM954.6 502.1c-0.8-1-1.7-1.9-2.7-2.7l-219-171.3c-3.5-2.7-8.5-2.1-11.2 1.4-1.1 1.4-1.7 3.1-1.7 4.9v81.3c0 2.5 1.1 4.8 3.1 6.3l115 90-115 90c-1.9 1.5-3.1 3.8-3.1 6.3v81.3c0 4.4 3.6 8 8 8 1.8 0 3.5-0.6 4.9-1.7l219-171.3c6.9-5.4 8.2-15.5 2.7-22.5zM291.1 328.1l-219 171.3c-1 0.8-1.9 1.7-2.7 2.7-5.4 7-4.2 17 2.7 22.5l219 171.3c1.4 1.1 3.1 1.7 4.9 1.7 4.4 0 8-3.6 8-8v-81.3c0-2.5-1.1-4.8-3.1-6.3l-115-90 115-90c1.9-1.5 3.1-3.8 3.1-6.3v-81.3c0-1.8-0.6-3.5-1.7-4.9-2.7-3.5-7.7-4.1-11.2-1.4z"></path>
    </svg>
  )
}

/** 预览区块的两个动作（文件资源管理器打开 / 编辑器打开）；单文件与多文件共用，路径取不到时无事发生 */
function previewActions(filePath?: string, line?: number): Action[] {
  return [
    {
      title: t('文件资源管理器打开'),
      iconRender() {
        return <FolderSvg />
      },
      onClick() {
        if (!filePath) return
        openPath(getFileParentDir(filePath))
      },
    },
    {
      title: t('编辑器打开'),
      iconRender() {
        return <EditorOpenSvg />
      },
      onClick() {
        if (!filePath) return
        editorService.openFile({ filePath, line })
      },
    },
  ]
}

/**
 * 多文件模式：所有文件共用一个 CodeBlock，文件名即切换入口（下拉）。
 *
 * 下拉之所以要经 `fileNameRender` 插槽塞进去：文件名与语言标签都是 CodeBlock 自己画的，
 * 外面换不掉。state 放在这层（而不是 CodeBlock 里）—— 切哪个文件是调用方的事，
 * CodeBlock 只管照着 props 渲染。不换 key：换了会连全屏态和 Monaco 实例一起重建。
 */
function MultiFileCodeView({
  files,
  workspace,
}: {
  files: ReadFileEntry[]
  workspace?: string
}) {
  const [active, setActive] = useState(0)
  // 越界兜底：uiData 来自历史消息，一个脏索引不该让整张卡片崩掉
  const index = active < files.length ? active : files.length - 1
  const file = files[index]

  return (
    <CodeBlock
      autoCenter
      maxHeight={'55vh'}
      width={'80%'}
      fileName={toShortPath(file.fullPath ?? '', workspace)}
      fileNameRender={() => (
        <Select
          className="code-file-switcher"
          /* 面板与代码块同属深色（Portal 挂 body，类名只能从这里给进去） */
          dropdownClassName="code-file-panel"
          /* 面板宽度交给内容：长路径把面板撑开（上限 500px，再长打省略号）。
             与触发器等宽的话，长路径只能在面板里折行，行高不齐、更难扫读 */
          dropdownWidth="content"
          value={index}
          onChange={(v) => setActive(Number(v))}
          options={files.map((f, i) => ({
            value: i,
            // 短路径（相对工作区）区分同名文件；title 里挂全路径，hover 可见
            label: toShortPath(f.fullPath ?? '', workspace),
            title: f.fullPath,
          }))}
        />
      )}
      contentKey={file.fullPath}
      showLineNumbers
      startLineNumber={file.startLine || 1}
      actions={previewActions(file.fullPath, file.startLine)}>
      {file.content ?? ''}
    </CodeBlock>
  )
}

class ReadFileMessage implements IToolCallMessage {
  getToolName(): string {
    return 'read_file'
  }
  getToolLabel(_type: string): string {
    return t('查看文件')
  }
  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const input = props.useContent.input
      const workspace =
        sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
        settingsState.value.defaultWorkspace

      // 多文件模式
      if (Array.isArray(input.paths) && input.paths.length > 0) {
        const paths = input.paths as string[]
        const first = toShortPath(paths[0], workspace)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color: 'var(--accent-color)', fontWeight: 500 }}>
              {first}
            </span>
            {paths.length > 1 && (
              <span style={{ color: '#999', fontSize: 12 }}>
                +{paths.length - 1}
              </span>
            )}
          </div>
        )
      }

      // 单文件模式
      const { path } = input
      let content = toShortPath(path, workspace)
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              color: 'var(--accent-color)',
              fontWeight: 500,
            }}>
            {content}
          </span>
          {props.message?.uiData?.startLine &&
            props.message?.uiData?.endLine && (
              <span style={{ color: '#999', fontSize: 12 }}>
                {`${props.message.uiData.startLine}-${props.message.uiData.endLine}`}
              </span>
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

    const workspace =
      sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
      settingsState.value.defaultWorkspace

    // 多文件模式：uiData.files → 一个代码块 + 文件名下拉（不再每个文件堆一个代码块）
    const files = props.message?.uiData?.files
    if (Array.isArray(files) && files.length > 0) {
      return (
        <div
          style={{
            padding: '0 10px',
            margin: '0px 20px',
          }}>
          <MultiFileCodeView files={files} workspace={workspace} />
        </div>
      )
    }

    // 单文件模式（原有逻辑）
    const value = props.message?.uiData?.content || props.message?.content
    const name = getUrlFileName(props.message?.uiData?.fullPath)
    const startLine = props.message?.uiData?.startLine || 1
    return (
      <div
        style={{
          padding: '0 10px',
          margin: '0px 20px',
        }}>
        <CodeBlock
          autoCenter
          maxHeight={"55vh"}
          width={"80%"}
          fileName={name}
          showLineNumbers
          startLineNumber={startLine}
          actions={previewActions(
            props.message?.uiData?.fullPath,
            props.message?.uiData?.startLine,
          )}
        >
          {value as any}
        </CodeBlock>
      </div >
    )
  }
  diyWrapper(): boolean {
    return true
  }
}

export default ReadFileMessage
