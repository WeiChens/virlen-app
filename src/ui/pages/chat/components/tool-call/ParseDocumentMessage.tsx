/**
 * ParseDocumentMessage — parse_document（文档解析）的消息展示。
 *
 * 折叠态一行：文件短路径（多文件带 `+N`），结果回来后再补「字符数」；
 * 展开态一张卡片：类型 / 大小 / 字符数 / 工作表 + 解析出的**正文**（等宽、超高自滚），
 * 失败项按 `errorKind` 用界面语言重建原因（`denied` / `backend` 这类带技术原文的原样给）。
 * **多份文档只渲染一张卡**（当前选中的那份），文件名位置换成下拉切换 —— 与 read_file 的多文件同款：
 * 一份份堆卡会把消息拉成几十屏，而且要知道看的是哪一份得挨个读卡头。
 *
 * 数据来源只有一处：工具结果的 `uiData`（Rust 组装，语言无关）。`note`（合并区域说明等）
 * 是解析器产出的**事实**（含工作表名、单元格区域等动态内容），随卡片原样展示、不做翻译；
 * OCR 场景下 `note` 与结构化 `ocr` 说明重复，此时只渲染后者（界面语言）。
 * 没有 `uiData` 的旧消息 / 浏览器回退路径整段回落 `message.content`，不做猜测解析。
 */
import { useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { getFileParentDir, toShortPath } from '@/utils/common'
import { formatSize } from '@/infrastructure/tools/file/common'
import { showToast } from '@/ui/components/shared/Toast'
import Select from '@/ui/components/shared/Select'
import CopySvg from '@/ui/components/icons/CopySvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { openPath } from '@tauri-apps/plugin-opener'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** `uiData.outTxtFile`（全文落盘结果，字段见 Rust `parse_document/mod.rs::OutFile::ui`） */
interface OutFileUi {
  path?: string
  ok?: boolean
  charCount?: number
  byteSize?: number
  error?: string
}

/** OCR 摘要（`uiData.ocr`，字段见 Rust `ocr.rs::ocr_ui`） */
interface OcrUi {
  available?: boolean
  unavailableKind?: string | null
  unavailableReason?: string | null
  images?: number
  chars?: number
  total?: number
}

/** 一份文档（`uiData.files[i]`；单文件时就是 `uiData` 本身） */
interface DocUi {
  file?: string
  ok?: boolean
  errorKind?: string
  error?: string
  fileType?: string
  byteSize?: number
  charCount?: number
  limit?: number
  requestedSheet?: string
  sheets?: unknown
  sheet?: unknown
  truncated?: boolean
  offset?: number
  nextOffset?: number | null
  note?: unknown
  text?: unknown
  ocr?: OcrUi | null
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** 当前会话工作目录（与 ReadFileMessage / securityService 一致） */
function currentWorkspace(): string {
  return (
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace ||
    ''
  )
}

/** 复制正文（与 message-bubble 同款：clipboard 不可用时退到 execCommand） */
function copyText(text: string) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => showToast(t('已复制到剪贴板')))
    .catch(() => {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    })
}

/** 失败原因：分类串 → 界面语言；分不了类的（含 `denied` / `backend`）原样给技术原文 */
function failureText(ui: DocUi): string {
  const fileType = asString(ui.fileType)
  switch (ui.errorKind) {
    case 'unsupported':
      return tpl('不支持的文档格式：$__ext__', {
        ext: fileType ? `.${fileType}` : '',
      })
    case 'too_large':
      return tpl('文件过大（$__size__ > $__limit__）', {
        size: formatSize(asNumber(ui.byteSize) ?? 0),
        limit: formatSize(asNumber(ui.limit) ?? 0),
      })
    case 'no_text':
      return t('未提取到文本，可能是扫描件或纯图片文档')
    case 'sheet_not_found':
      return tpl('工作表「$__name__」不存在', {
        name: asString(ui.requestedSheet),
      })
    default:
      return asString(ui.error) || t('解析失败')
  }
}

/** OCR 说明（结构化字段 → 界面语言；分类外的原因原文照给） */
function ocrText(ocr: OcrUi): string | null {
  if (ocr.available === false) {
    const reason =
      ocr.unavailableKind === 'models'
        ? t('端侧视觉模型未安装')
        : ocr.unavailableKind === 'images'
          ? t('文档内嵌图片提取失败')
          : asString(ocr.unavailableReason)
    return tpl('OCR 不可用：$__reason__', { reason })
  }
  const images = asNumber(ocr.images) ?? 0
  if (images > 0) {
    return tpl('端侧 OCR 读取了 $__images__ 张图片（$__chars__ 字符）', {
      images,
      chars: asNumber(ocr.chars) ?? 0,
    })
  }
  const total = asNumber(ocr.total) ?? 0
  if (total > 0) {
    return tpl('OCR 未识别出文字（共 $__total__ 张图片）', { total })
  }
  return null
}

/**
 * 一份文档卡片（成功 = 元信息 + 正文；失败 = 原因 + 可用工作表）
 *
 * `nameSlot` 是多份文档时的文件名位置（下拉切换）—— 单份不给，照旧显示文件名本身。
 */
function DocCard({ ui, nameSlot }: { ui: DocUi; nameSlot?: React.ReactNode }) {
  const fullPath = asString(ui.file)
  const name = fullPath ? toShortPath(fullPath, currentWorkspace()) : ''
  const fileType = asString(ui.fileType)
  const byteSize = asNumber(ui.byteSize)

  // 失败：一份文档失败不影响其它文档 —— 卡片自己报原因
  if (ui.ok === false) {
    const sheets = asStringList(ui.sheets)
    return (
      <div className="doc-card is-failed">
        <div className="doc-head">
          {/* 多份文档时文件名位置留给下拉（失败项也要能切走）；单份照旧是文件名本身 */}
          <div className='doc-name-wrapper'>
            {nameSlot ??
              (name && (
                <span className="doc-name" title={fullPath}>
                  {name}
                </span>
              ))}
          </div>
          {fileType && <span className="doc-badge">{fileType}</span>}
          {byteSize != null && (
            <span className="doc-badge">{formatSize(byteSize)}</span>
          )}
        </div>
        <div className="doc-error">⚠️ {failureText(ui)}</div>
        {ui.errorKind === 'sheet_not_found' && sheets.length > 0 && (
          <div className="doc-line">
            {tpl('可用工作表：$__list__', { list: sheets.join(', ') })}
          </div>
        )}
      </div>
    )
  }

  const text = asString(ui.text)
  const chars = asNumber(ui.charCount)
  const sheet = asString(ui.sheet)
  const sheets = asStringList(ui.sheets)
  const note = asString(ui.note)
  const ocr = ui.ocr && typeof ui.ocr === 'object' ? ui.ocr : null
  const ocrLine = ocr ? ocrText(ocr) : null

  return (
    <div className="doc-card">
      <div className="doc-head">
        {/* 多份文档时文件名位置留给下拉；单份照旧是文件名本身 */}
        <div className='doc-name-wrapper'>
          {nameSlot ??
            (name && (
              <span className="doc-name" title={fullPath}>
                {name}
              </span>
            ))}
        </div>

        {fileType && <span className="doc-badge">{fileType}</span>}
        {byteSize != null && (
          <span className="doc-badge">{formatSize(byteSize)}</span>
        )}
        {chars != null && (
          <span className="doc-badge">
            {tpl('$__count__ 字符', { count: chars })}
          </span>
        )}
        {sheet ? (
          <span className="doc-badge">
            {tpl('工作表：$__name__', { name: sheet })}
          </span>
        ) : sheets.length > 0 ? (
          <span className="doc-badge">
            {tpl('$__count__ 个工作表', { count: sheets.length })}
          </span>
        ) : null}
        <span className="doc-head-actions">
          {!!text && (
            <button
              className="doc-icon-btn"
              title={t('复制文本')}
              aria-label={t('复制文本')}
              onClick={(e) => {
                // 卡片外层（工具调用行）点了会折叠，按钮上的点击必须拦下来
                e.stopPropagation()
                copyText(text)
              }}>
              <CopySvg fill="currentColor" />
            </button>
          )}
          {fullPath && (
            <button
              className="doc-icon-btn"
              title={t('文件资源管理器打开')}
              aria-label={t('文件资源管理器打开')}
              onClick={(e) => {
                e.stopPropagation()
                openPath(getFileParentDir(fullPath)).catch(() =>
                  showToast(t('打开失败'), 2000),
                )
              }}>
              <FolderSvg fill="currentColor" />
            </button>
          )}
        </span>
      </div>
      {/* OCR 场景下 note 就是 OCR 说明（Rust `summary_note`）——上面已用结构化字段重建，不重复 */}
      {note && !ocrLine && <div className="doc-line">💡 {note}</div>}
      {ocrLine && <div className="doc-line">🖼 {ocrLine}</div>}
      {ui.truncated === true && (
        <div className="doc-line">
          ✂️{' '}
          {tpl('内容已截断（共 $__total__ 字符）· 用 offset=$__offset__ 继续读取', {
            total: chars ?? text.length,
            offset: asNumber(ui.nextOffset) ?? 0,
          })}
        </div>
      )}
      <pre className="doc-text">{text || t('（未提取到文本）')}</pre>
    </div>
  )
}

/**
 * 展开视图根组件：只承载需要 hook 的渲染 —— 类方法里不能调 hook，
 * 且 workspace 每次渲染都要取最新值（会话可能已切换）。
 *
 * 多份文档只渲染**一张**卡（当前选中的那份），文件名位置换成下拉切换（与 read_file 的多文件同款）。
 */
function DocView({
  files,
  outFile,
}: {
  files: DocUi[]
  outFile: OutFileUi | null
}) {
  // 顶层无条件调用：本组件只在展开时挂载（折叠时 getExpandView 返回 null），
  // 挂载本身等价于一次用户手势，不会被被动的消息到达 / 列表重挂载触发
  const rootRef = useAutoCenter()
  const [active, setActive] = useState(0)
  // 越界兜底：uiData 来自历史消息，一个脏索引不该让整张卡片崩掉
  const index = active < files.length ? active : files.length - 1
  const file = files[index]
  const workspace = currentWorkspace()
  return (
    <div className="doc-view" ref={rootRef}>
      <DocCard
        /* 换文件换 key：正文重挂载，滚动位置随之归零（否则停在上一个文档的偏移上） */
        key={`${asString(file.file)}#${index}`}
        ui={file}
        nameSlot={
          files.length > 1 ? (
            <Select
              className="doc-file-switcher"
              /* 长路径在面板里按内容撑开（上限 500px），不靠触发器那点宽度折行 */
              dropdownWidth="content"
              value={index}
              onChange={(v) => setActive(Number(v))}
              options={files.map((f, i) => ({
                value: i,
                // 短路径（相对工作区）区分同名文件；title 里挂全路径，hover 可见
                label: toShortPath(asString(f.file), workspace),
                title: asString(f.file),
              }))}
            />
          ) : undefined
        }
      />
      {outFile && (
        <div className={`doc-outfile${outFile.ok === false ? ' is-failed' : ''}`}>
          {outFile.ok === false
            ? `⚠️ ${tpl('全文保存失败：$__error__', {
              error: asString(outFile.error),
            })}`
            : `💾 ${tpl('全文已保存到 $__path__（$__count__ 字符 · $__size__）', {
              path: asString(outFile.path),
              count: asNumber(outFile.charCount) ?? 0,
              size: formatSize(asNumber(outFile.byteSize) ?? 0),
            })}`}
        </div>
      )}
    </div>
  )
}
class ParseDocumentMessage implements IToolCallMessage {
  getToolName(): string {
    return 'parse_document'
  }

  getToolLabel(_type: string): string {
    return t('解析文档')
  }

  getShortText(props: ToolMessageProps): string | React.ReactNode {
    try {
      const input = (props.useContent.input ?? {}) as Record<string, unknown>
      const paths = asStringList(input.paths)
      const single = asString(input.path)
      const list = paths.length > 0 ? paths : single ? [single] : []
      // 入参就没有路径（工具直接报参数错误）：没有可展示的主体，退回工具名
      if (list.length === 0) return t('解析文档')

      const chars = asNumber((props.message?.uiData as any)?.charCount)
      return (
        <div className="doc-short">
          <span className="doc-short-path" title={list[0]}>
            {toShortPath(list[0], currentWorkspace())}
          </span>
          {list.length > 1 && (
            <span className="doc-short-extra">+{list.length - 1}</span>
          )}
          {chars != null && (
            <span className="doc-short-extra">
              {tpl('$__count__ 字符', { count: chars })}
            </span>
          )}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    // diyWrapper() 为 true：外层不再帮我们判 expand，必须自己早退，
    // 否则折叠时也会整卡渲染（顺带会让 autoCenter 误触发）
    if (!props.expand) return null

    const ui = props.message?.uiData as any
    const content =
      typeof props.message?.content === 'string' ? props.message.content : ''

    // 结构化数据（Rust 组装）：多份 = `{ files: [...] }`；单份 = 对象本身
    const files: DocUi[] | null = Array.isArray(ui?.files)
      ? (ui.files as DocUi[])
      : ui && typeof ui === 'object' && (ui.ok === true || typeof ui.errorKind === 'string')
        ? [ui as DocUi]
        : null

    if (!files) {
      if (!props.message) {
        // 结果还没回来：先给一个占位，避免展开后什么都没有
        return (
          <div className="doc-view">
            <div className="doc-pending">{t('解析中…')}</div>
          </div>
        )
      }
      // 旧消息 / 浏览器回退路径：没有结构化 uiData，整段回落模型侧原文
      if (props.message.isError) {
        return <div className="error">{content}</div>
      }
      return content ? <pre className="doc-raw">{content}</pre> : null
    }

    const outFile = (ui.outTxtFile as OutFileUi | undefined) ?? null
    return <DocView files={files} outFile={outFile} />
  }

  diyWrapper(): boolean {
    // 自绘卡片（头部 / 正文 / 边框 / 宽度上限），不使用 .tool-call-expand-view 的 fit-content 包裹
    return true
  }
}

export default ParseDocumentMessage
