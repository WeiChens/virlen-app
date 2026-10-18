/**
 * WorkspaceFilePanel — 工作目录文件在**右侧**打开：文本可直接编辑（Ctrl/Cmd+S 或「保存」落盘），
 * 图片 / 音频 / 视频就地预览，其余类型交给系统程序。
 *
 * 五条口径：
 * 1. **编辑后不自动保存**：草稿只在面板里，`dirty` 由「草稿 ≠ 载入内容」判定；关闭 / 换文件前
 *    由宿主（chat-view）确认，面板自己的关闭按钮也确认一次；
 * 2. **保存前比对 hash**：内容可能已被终端 / AI 改过（见 `workspace-file-service`），冲突时报错，
 *    不静默覆盖；
 * 3. **md / html / svg 多一个预览**：默认停在编辑，顶部 tab 切换；预览渲染的是**草稿**（所见即
 *    当前所改），不是磁盘上的旧内容；
 * 4. **媒体走 blob URL**：读回字节后自己造 URL 并在卸载 / 换文件时 `revokeObjectURL`，
 *    避免把文件直接挂到 webview 的 file://（那需要放开 asset 协议范围）；图片交给
 *    `image-viewer.tsx`（滚轮缩放 / 拖动平移 / 右键复制与旋转），本文件只管取字节。
 * 5. **宽度可拖**：面板在右侧，拖左边缘改宽；宽度进 localStorage（下次打开沿用）。
 * 6. **HTML 的脚本 / 外部资源权限来自全局设置**（设置 → 安全 → HTML 预览）：面板只在被安全默认
 *    挡住时给一条提示 + 指路，不在这里放开关 —— 那等于每打开一个文件重勾一次。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { openPath } from '@tauri-apps/plugin-opener'
import { t } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import settingsEvent from '@/events/settingsEvent'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import CodeEditor from '@/ui/components/code-editor/CodeEditor'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import ExportSvg from '@/ui/components/icons/ExportSvg'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import ImageViewer from './image-viewer'
import { monacoLanguageOf, relativeDirOf, textPreviewKindOf } from '@/domain/files/preview'
import { buildPreviewDocument, previewNeeds } from '@/domain/files/html-preview'
import {
  allowPreviewRoot,
  newPreviewToken,
  previewBaseUrl,
  revokePreviewRoot,
} from '@/infrastructure/preview-asset'
import { securityService } from '@/services/security-service'
import {
  loadWorkspaceFile,
  saveWorkspaceText,
  WorkspaceFileError,
  type LoadedWorkspaceFile,
  type WorkspaceFileErrorCode,
} from '@/services/workspace-file-service'
import './style.scss'

interface Props {
  /** 要打开的文件绝对路径（工作目录内） */
  path: string
  sessionId?: string
  /** 关闭（宿主负责清空 openFile；脏数据确认已经在本组件内做过） */
  onClose: () => void
  /** 脏标记变化（宿主据此在「切文件 / 切会话」前确认） */
  onDirtyChange?: (dirty: boolean) => void
}

/** 面板宽度的记忆键与范围 */
const WIDTH_KEY = 'virlen-workspace-file-width'
const MIN_WIDTH = 360
const MAX_WIDTH = 960
const DEFAULT_WIDTH = 560

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; file: LoadedWorkspaceFile }
  | { status: 'error'; message: string; code?: WorkspaceFileErrorCode }

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

function initialWidth(): number {
  const saved = Number(localStorage.getItem(WIDTH_KEY))
  return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH
    ? saved
    : DEFAULT_WIDTH
}

/** 失败 → 用户能看懂的一句话（未知原因原样带上，便于排查） */
function describeError(error: unknown): { message: string; code?: WorkspaceFileErrorCode } {
  if (error instanceof WorkspaceFileError) {
    switch (error.code) {
      case 'too-large':
        return { code: error.code, message: t('文件过大，无法在应用内打开') }
      case 'not-found':
        return { code: error.code, message: t('文件不存在或已被移走') }
      case 'not-file':
        return { code: error.code, message: t('该路径不是文件') }
      case 'conflict':
        return { code: error.code, message: t('文件已被其他程序修改，请重新加载后再保存') }
      case 'binary':
        return {
          code: error.code,
          message: t('无法以文本方式打开（可能是二进制文件或未知编码）'),
        }
      default:
        return { code: error.code, message: error.message }
    }
  }
  return { message: typeof error === 'string' ? error : String(error) }
}

function WorkspaceFilePanel({
  path,
  sessionId,
  onClose,
  onDirtyChange,
}: Props) {
  const name = baseName(path)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  /** 文本草稿（非文本时恒为空串） */
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [width, setWidth] = useState(initialWidth)
  const [resizing, setResizing] = useState(false)
  /** 媒体 blob URL（非媒体为空串） */
  const [mediaUrl, setMediaUrl] = useState('')
  /** 文本文件的查看方式：md / html / svg 可选预览，其余只有编辑 */
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit')
  /** SVG 预览的 blob URL（draft 里就是 SVG 源码） */
  const [svgUrl, setSvgUrl] = useState('')
  /**
   * HTML 预览的脚本 / 外部资源权限：**全局设置**（设置 → 安全 → HTML 预览）。
   * 不在面板里放开关 —— 那等于每打开一个文件都要重勾一次（实测反馈）。
   * `allowRemote` 再与 `allowScripts` 取一次与：外部脚本没有脚本执行权限时毫无意义。
   */
  const allowScripts = settingsState.value.htmlPreviewAllowScripts
  const allowRemote = settingsState.value.htmlPreviewAllowRemote && allowScripts
  /** HTML 预览的本地资源基址：undefined = 登记中，null = 登记失败（无 base），string = 就绪 */
  const [previewBase, setPreviewBase] = useState<string | null | undefined>(undefined)

  const panelRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)
  widthRef.current = width
  const dirtyRef = useRef(false)
  /** 保存中重入保护（Ctrl+S 连按） */
  const savingRef = useRef(false)
  /** 上一次加载的文件：**只有换文件**才重置查看状态与安全开关（重读同一个文件不该清掉勾选） */
  const lastPathRef = useRef(path)

  const dirty =
    state.status === 'ready' &&
    state.file.kind === 'text' &&
    draft !== state.file.content
  dirtyRef.current = dirty

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    setDraft('')
    if (lastPathRef.current !== path) {
      lastPathRef.current = path
      // 换文件回到编辑（默认模式）；脚本权限是全局设置，不随文件重置
      setViewMode('edit')
    }
    try {
      const file = await loadWorkspaceFile(path, sessionId)
      setState({ status: 'ready', file })
      if (file.kind === 'text') setDraft(file.content)
    } catch (error) {
      setState({ status: 'error', ...describeError(error) })
    }
  }, [path, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  // 脏标记上报：宿主在切换文件 / 会话前要知道
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // 媒体 → blob URL；换文件 / 卸载时释放
  useEffect(() => {
    if (state.status !== 'ready' || state.file.kind === 'text' || state.file.kind === 'other') {
      setMediaUrl('')
      return
    }
    // Uint8Array 的底层 buffer 可能是 SharedArrayBuffer，Blob 只接 ArrayBuffer → 拷一份再交给它
    const buffer = new ArrayBuffer(state.file.bytes.byteLength)
    new Uint8Array(buffer).set(state.file.bytes)
    const url = URL.createObjectURL(new Blob([buffer], { type: state.file.mime }))
    setMediaUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [state])

  const save = useCallback(async () => {
    if (savingRef.current) return
    if (state.status !== 'ready' || state.file.kind !== 'text') return
    if (draft === state.file.content) return

    savingRef.current = true
    setSaving(true)
    try {
      const result = await saveWorkspaceText(path, draft, state.file.hash10, sessionId)
      // 基线跟着换：保存成功之后才算「不脏」；hash 也要更新，否则第二次保存会误报冲突
      setState({
        status: 'ready',
        file: {
          ...state.file,
          content: draft,
          hash10: result.hash10,
          byteSize: result.byteSize,
          lineCount: result.lineCount,
        },
      })
      showToast(t('已保存'), 1500)
    } catch (error) {
      const { message, code } = describeError(error)
      if (code === 'conflict') {
        await MessageBox.propt(t('保存失败'), message, {
          confirmText: t('知道了'),
          cancelText: t('取消'),
        })
      } else {
        showToast(message, 3000)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [state, draft, path, sessionId])

  // Ctrl+S 回调走 ref：注册一次之后闭包也要读到最新草稿
  const saveRef = useRef(save)
  saveRef.current = save

  const reload = useCallback(async () => {
    if (dirtyRef.current) {
      const confirmed = await MessageBox.propt(
        t('放弃未保存的修改？'),
        t('重新加载会用磁盘上的内容覆盖当前草稿。'),
        { confirmText: t('重新加载'), cancelText: t('取消'), danger: true },
      )
      if (!confirmed) return
    }
    await load()
  }, [load])

  const requestClose = useCallback(async () => {
    if (dirtyRef.current) {
      const confirmed = await MessageBox.propt(
        t('放弃未保存的修改？'),
        t('关闭后这些修改会丢失。'),
        { confirmText: t('放弃并关闭'), cancelText: t('取消'), danger: true },
      )
      if (!confirmed) return
    }
    onClose()
  }, [onClose])

  const openInSystem = useCallback(() => {
    openPath(path).catch(() => showToast(t('打开失败'), 2000))
  }, [path])

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    const right = rect.right
    setResizing(true)
    // 指针拖出面板时也要保持 col-resize（与左侧栏拖拽同一手法）
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: MouseEvent) => {
      const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.72))
      const next = Math.max(MIN_WIDTH, Math.min(max, Math.round(right - moveEvent.clientX)))
      setWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      // 松手才落盘：拖动过程中每帧写 localStorage 没有意义
      localStorage.setItem(WIDTH_KEY, String(widthRef.current))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const textFile = state.status === 'ready' && state.file.kind === 'text' ? state.file : null
  const previewKind = textPreviewKindOf(name)
  const showPreview = viewMode === 'preview' && textFile !== null && previewKind !== null

  // SVG 预览：把草稿当图片渲染（`<img>` 里的 SVG 不会执行脚本，比注入 innerHTML 安全）
  useEffect(() => {
    if (!showPreview || previewKind !== 'svg') {
      setSvgUrl('')
      return
    }
    const url = URL.createObjectURL(new Blob([draft], { type: 'image/svg+xml' }))
    setSvgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [showPreview, previewKind, draft])

  const htmlPreviewActive = showPreview && previewKind === 'html'

  // HTML 预览：把「当前工作区」登成可读根（沙箱范围 = 工作区），基址再补上文件自己的子目录
  // （页面里的 `./app.css` 是相对文件目录的）；关闭 / 切模式即撤销。
  // 登记失败（非 Tauri / 权限）不报错：不注入 base，预览仍然能显示，只是相对资源 404。
  useEffect(() => {
    if (!htmlPreviewActive) {
      setPreviewBase(undefined)
      return
    }
    let cancelled = false
    const token = newPreviewToken()
    setPreviewBase(undefined)
    void (async () => {
      try {
        const root = await securityService.getWorkspace(sessionId)
        await allowPreviewRoot(token, root, allowScripts)
        if (!cancelled) setPreviewBase(previewBaseUrl(token, relativeDirOf(path, root)))
      } catch {
        if (!cancelled) setPreviewBase(null)
      }
    })()
    return () => {
      cancelled = true
      void revokePreviewRoot(token)
    }
  }, [htmlPreviewActive, allowScripts, sessionId, path])

  /** 注入 base / CSP 后的完整 HTML 文档（DOMParser 不执行脚本） */
  const htmlDoc = useMemo(
    () =>
      showPreview && previewKind === 'html'
        ? buildPreviewDocument(draft, previewBase ?? null, allowScripts, allowRemote)
        : '',
    [showPreview, previewKind, draft, previewBase, allowScripts, allowRemote],
  )

  /** 页面需要哪些权限（脚本 / 外部脚本）—— 用得着时在预览上方给一句话 + 一键开启 */
  const needs = useMemo(
    () => (htmlPreviewActive ? previewNeeds(draft) : null),
    [htmlPreviewActive, draft],
  )

  const openPreviewSettings = useCallback(() => {
    // 直达「安全 → HTML 预览」：提示条只能把人送到门口，开关本身只住在设置里
    settingsEvent.emit('openSettings', 'security-preview')
  }, [])

  const renderBody = () => {
    if (state.status === 'loading') {
      return <div className="wfp-hint">{t('正在读取文件…')}</div>
    }
    if (state.status === 'error') {
      return (
        <div className="wfp-hint is-error">
          <p>{state.message}</p>
          <button type="button" className="wfp-action" onClick={openInSystem}>
            {t('在系统程序中打开')}
          </button>
        </div>
      )
    }

    const file = state.file
    if (file.kind === 'text') {
      if (showPreview) {
        if (previewKind === 'markdown') {
          return (
            <div className="wfp-preview">
              <MarkdownRenderer content={draft} />
            </div>
          )
        }
        if (previewKind === 'html') {
          if (previewBase === undefined) {
            return <div className="wfp-hint">{t('正在准备预览…')}</div>
          }
          // sandbox="" = 全部限制（脚本不执行、不弹窗、不改顶部导航）；开启脚本时只加
          // allow-scripts，**绝不加 allow-same-origin**（否则脚本会拿到应用页面的同源能力）。
          return (
            <>
              {/* 被安全默认挡住时，控制台报错用户看不到 —— 在预览上方给一句人话，并把人送到设置 */}
              {!allowScripts && needs?.hasScripts && (
                <div className="wfp-preview-note">
                  <span>{t('页面包含脚本，已按安全默认阻止运行')}</span>
                  <button
                    type="button"
                    className="wfp-action"
                    onClick={openPreviewSettings}>
                    {t('前往设置')}
                  </button>
                </div>
              )}
              {allowScripts && !allowRemote && needs?.hasRemoteScripts && (
                <div className="wfp-preview-note">
                  <span>{t('页面引用了外部（CDN）脚本')}</span>
                  <button
                    type="button"
                    className="wfp-action"
                    onClick={openPreviewSettings}>
                    {t('前往设置')}
                  </button>
                </div>
              )}
              <iframe
                key={`${previewBase ?? 'no-base'}|${allowScripts ? 'js' : 'no-js'}|${allowRemote ? 'remote' : 'local'}`}
                className="wfp-frame"
                title={name}
                sandbox={allowScripts ? 'allow-scripts' : ''}
                srcDoc={htmlDoc}
              />
            </>
          )
        }
        if (svgUrl) {
          return (
            <ImageViewer
              src={svgUrl}
              name={name}
              mime="image/svg+xml"
              onOpenInSystem={openInSystem}
            />
          )
        }
      }
      return (
        <div className="wfp-editor">
          <CodeEditor
            value={draft}
            onChange={setDraft}
            language={monacoLanguageOf(name)}
            height="100%"
            ariaLabel={name}
            onSave={() => void saveRef.current()}
          />
        </div>
      )
    }
    if (file.kind === 'other') {
      return (
        <div className="wfp-hint">
          <p>{t('暂不支持预览该类型')}</p>
          <button type="button" className="wfp-action" onClick={openInSystem}>
            {t('在系统程序中打开')}
          </button>
        </div>
      )
    }
    if (!mediaUrl) return <div className="wfp-hint">{t('正在读取文件…')}</div>

    if (file.kind === 'image') {
      return (
        <ImageViewer
          src={mediaUrl}
          name={name}
          mime={file.mime}
          onOpenInSystem={openInSystem}
        />
      )
    }
    if (file.kind === 'audio') {
      return (
        <div className="wfp-media is-audio">
          <audio controls src={mediaUrl} />
          <p className="wfp-media-hint">{t('若无法播放该格式，可用系统程序打开')}</p>
        </div>
      )
    }
    return (
      <div className="wfp-media is-video">
        <video controls src={mediaUrl} />
        <p className="wfp-media-hint">{t('若无法播放该格式，可用系统程序打开')}</p>
      </div>
    )
  }

  return (
    <aside
      ref={panelRef}
      className={`workspace-file-panel${resizing ? ' is-resizing' : ''}`}
      style={{ width }}
      tabIndex={-1}
      onKeyDown={(event) => {
        // 焦点在面板内（含媒体控件）时也能保存；Monaco 里则由它自己接管
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void saveRef.current()
        }
      }}>
      <div
        className="wfp-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整面板宽度')}
        onMouseDown={startResize}
      />

      <div className="wfp-head">
        <FileTypeIcon filename={name} className="wfp-icon" />
        <span className="wfp-name" title={path}>
          {name}
        </span>
        {dirty && <span className="wfp-dirty" title={t('未保存')} />}
        <span className="wfp-spacer" />
        {textFile && (
          <button
            type="button"
            className="wfp-action is-primary"
            onClick={() => void saveRef.current()}
            disabled={!dirty || saving}
            title={`${t('保存')} (Ctrl+S)`}>
            {saving ? t('保存中…') : t('保存')}
          </button>
        )}
        <button
          type="button"
          className="wfp-icon-btn"
          onClick={() => void reload()}
          title={t('重新加载')}
          aria-label={t('重新加载')}>
          <RefreshSvg />
        </button>
        <button
          type="button"
          className="wfp-icon-btn"
          onClick={openInSystem}
          title={t('在系统程序中打开')}
          aria-label={t('在系统程序中打开')}>
          <ExportSvg />
        </button>
        <button
          type="button"
          className="wfp-icon-btn"
          onClick={() => void requestClose()}
          title={t('关闭')}
          aria-label={t('关闭')}>
          <CloseSvg />
        </button>
      </div>

      {state.status === 'ready' && (
        <div className="wfp-path" title={path}>
          {path}
        </div>
      )}

      {/* 编辑 / 预览：只有 md / html / svg 有第二项，默认编辑 */}
      {textFile && previewKind && (
        <div className="wfp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'edit'}
            className={`wfp-tab${viewMode === 'edit' ? ' is-active' : ''}`}
            onClick={() => setViewMode('edit')}>
            {t('编辑')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'preview'}
            className={`wfp-tab${viewMode === 'preview' ? ' is-active' : ''}`}
            onClick={() => setViewMode('preview')}>
            {t('预览')}
          </button>
        </div>
      )}

      <div className="wfp-body">{renderBody()}</div>
    </aside>
  )
}

// 必须 observer：HTML 预览的脚本权限住在全局设置里，设置改完要立刻反映到 iframe / 提示条上
export default observer(WorkspaceFilePanel)
