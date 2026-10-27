/**
 * ModelView — 右侧面板里的 3D 模型预览（three）。
 *
 * 八条口径：
 * 1. **three 只在打开模型时才下载**：本组件静态 import 的只有纯数据（`model-presets`），
 *    场景管理器与加载器都是 `import()` —— 否则一个 600KB 的库会进主包（pdfjs 同一手法）。
 * 2. **字节由面板给**（`workspace-file-service` 已过安全校验与体积上限）：这里不读盘、不造 URL。
 *    **例外是贴图**：模型引用的同目录贴图由 `model-loaders` 按 `path` 去读（`model-textures.ts`）。
 * 3. **失败给两层信息**：一句人话（`t('无法解析这个模型')` / 外部资源 / 不支持的格式）
 *    + 库抛的原文（排查用，不抢注意力），并留一个「在系统程序中打开」的出口。
 * 4. **标签切走不卸载**（`side-panel` 只切显隐）：场景仍然活着，`ModelScene` 自己在 0 尺寸时
 *    停止渲染 —— 所以这里不需要（也不能）在隐藏时重建 WebGL 上下文。
 * 5. **截图走「另存为」对话框**：与应用里图片另存的同一条路（`saveImageAs`），
 *    浏览器 dev 环境自动退化成下载。
 * 6. **解析完成前只给转圈**：画布靠 `visibility` 藏起来（不动布局，ResizeObserver 量到的尺寸不变），
 *    否则会先看到空舞台上的网格 / 坐标轴，模型再一块块补上 —— 即「边加载边显示」。
 *    此外换模型 / 卸载时必须调 `LoadedModel.dispose()`：本地贴图的 blob URL 归它管。
 * 7. **异常不能只去控制台**：工具欄末尾的日志按钮（徽标 = 警告 + 错误条数）打开「异常日志」
 *    弹窗。所有可能出错的分支都要往 `model-diagnostics.ts` 投一条 —— 贴图缺失 / 过大 / 超出
 *    预算 / 失效槽被移除（`model-loaders`·`model-textures`）、没有几何 / 没有网格
 *    （`model-scene`·本组件）、WebGL 起不来 / 动态 import 失败 / 解析失败（本组件）。
 *    ⚠️ 日志是**按模型一轮一轮**的：`sessionRef` 让上一份模型迟到的异步回调（贴图结算）
 *    写不进下一份的日志。
 * 8. **环境（场景预设）是全应用一份**：不放在本组件的 state 里 —— 标签同时挂着（`parkedTabs`
 *    不卸载，常驻标签只切显隐），两个模型就是两个实例，各自一份会「改 A 的 B 不知道」。
 *    真相在 `model-environment.ts`（localStorage + 跨实例订阅），本组件只订阅与应用；
 *    换档即落盘，重启后沿用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import Select from '@/ui/components/shared/Select'
import AlertSvg from '@/ui/components/icons/AlertSvg'
import { saveImageAs } from '@/utils/clipboard'
import {
  MODEL_PRESETS,
  modelPresetOf,
} from './model-presets'
import { setModelPresetId, useModelPresetId } from './model-environment'
import type { ModelScene, ModelStats } from './model-scene'
import type { ModelLoadErrorCode } from './model-loaders'
import {
  appendDiagnostic,
  countDiagnostics,
  loadFailureDiagnostic,
  DIAGNOSTIC_TITLES,
  type DiagnosticEntry,
  type DiagnosticInput,
} from './model-diagnostics'
import ModelLogModal from './model-log'
import LoadingIcon from './loading-icon'

interface Props {
  /** 模型原始字节（调用方已读过安全校验与体积上限） */
  bytes: Uint8Array
  /** 文件名（判定扩展名 / 截图默认名都用它） */
  name: string
  /**
   * 模型在磁盘上的绝对路径：给了才会去同目录找它引用的贴图（`model-textures.ts`）。
   * 只有字节的宿主（用例）可以不给 —— 那就是「外部贴图一律加载不到」的老行为。
   */
  path?: string
  onOpenInSystem: () => void
}

/** 工具栏的显隐 / 动效开关 */
interface ViewOptions {
  wireframe: boolean
  showGrid: boolean
  showAxes: boolean
  autoRotate: boolean
  /** 用模型自带的 punctual 灯（默认关：强度是按作者场景尺度标的，缩放后会过曝） */
  useModelLights: boolean
}

const DEFAULT_OPTIONS: ViewOptions = {
  wireframe: false,
  showGrid: true,
  showAxes: true,
  autoRotate: false,
  useModelLights: false,
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/** 解析失败 → 一条 error（`ModelLoadError.code` 决定标题，库原文进 detail） */
export default function ModelView({ bytes, name, path, onOpenInSystem }: Props) {
  const holderRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<ModelScene | null>(null)
  const [sceneReady, setSceneReady] = useState(false)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<{ code?: ModelLoadErrorCode; text: string }>({ text: '' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  /** 小写扩展名（大写显示） */
  const [format, setFormat] = useState('')
  /** 本地贴图统计（`found < total` = 有贴图没在磁盘上找到；`null` = 模型没有外部贴图引用） */
  const [textures, setTextures] = useState<{ found: number; total: number } | null>(null)
  /** 动画只留展示需要的字段：THREE.AnimationClip 不进 state */
  const [clips, setClips] = useState<{ name: string; duration: number }[]>([])
  const [clipIndex, setClipIndex] = useState(-1)
  /** 环境（场景预设）：**全局唯一**，见口径 8 与 `model-environment.ts` */
  const presetId = useModelPresetId()
  const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS)
  const [infoOpen, setInfoOpen] = useState(false)
  /**
   * 异常日志（当前这份模型的）：贴图缺失 / 贴图过大 / 失效槽被移除 / 解析失败 / WebGL 起不来。
   * 工具栏那个徽标就数它（`countDiagnostics`），点开是 `model-log.tsx` 的弹窗。
   */
  const [diagnostics, setDiagnostics] = useState<readonly DiagnosticEntry[]>([])
  const [logOpen, setLogOpen] = useState(false)
  /**
   * 日志的轮次：贴图是**异步结算**的（`watchTextures` 会在一批贴图结束后才回报），
   * 换模型后旧那一轮的迟到回调不能写进新模型的日志。
   */
  const sessionRef = useRef(0)

  const pushDiagnostic = useCallback((input: DiagnosticInput) => {
    setDiagnostics((prev) => appendDiagnostic(prev, input))
  }, [])

  /** 当前这份模型的收尾动作（本地贴图的 blob URL 归它管，见口径 6） */
  const releaseRef = useRef<(() => void) | null>(null)

  // 1) 建场景（只一次）：three 在这一步才下载
  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    let cancelled = false
    let scene: ModelScene | null = null
    void (async () => {
      try {
        const { ModelScene } = await import('./model-scene')
        if (cancelled) return
        scene = new ModelScene(holder, pushDiagnostic)
        sceneRef.current = scene
        setSceneReady(true)
      } catch (cause) {
        if (cancelled) return
        // 建不出 WebGL 上下文（老驱动 / 远程桌面）：当成「无法解析」并把原文给出来
        pushDiagnostic({
          level: 'error',
          code: 'webgl',
          title: DIAGNOSTIC_TITLES.webgl,
          detail: messageOf(cause),
        })
        setPhase('error')
        setError({ text: messageOf(cause) })
      }
    })()
    return () => {
      cancelled = true
      sceneRef.current = null
      scene?.dispose()
    }
  }, [pushDiagnostic])

  // 2) 环境（场景预设）：全局一份，换档 / 别的预览改了档都会走到这里。
  //    ⚠️ 建场景时**不**顺手 applyPreset：`sceneReady` 一翻就是这里，两处都调会白建一张环境贴图
  //    （渐变档每次 `pmrem.fromEquirectangular` 都重新渲一遍）
  useEffect(() => {
    sceneRef.current?.applyPreset(modelPresetOf(presetId))
  }, [presetId, sceneReady])

  // 3) 解析模型：换文件（bytes 变了）或场景刚建好都会走到这里
  useEffect(() => {
    const scene = sceneRef.current
    if (!sceneReady || !scene) return
    let cancelled = false
    /** 本轮的日志轮次：上一轮模型迟到的异步回调（贴图结算）不能写进这一轮 */
    const session = ++sessionRef.current
    const report = (input: DiagnosticInput): void => {
      if (session !== sessionRef.current) return
      pushDiagnostic(input)
    }
    setPhase('loading')
    setError({ text: '' })
    setStats(null)
    setClips([])
    setClipIndex(-1)
    setTextures(null)
    // 换模型 = 新一份日志（上一个是好是坏，与这一个无关）
    setDiagnostics([])
    void (async () => {
      // 先把模块拿进来：`ModelLoadError` 要在 catch 里做 instanceof 判断，不能解构在 try 里。
      // ⚠️ 这一步自己就会失败（dev server 重启后旧 chunk 没了 / dist 被换掉）：不能让它
      // 抛到外面 —— 那样 phase 永远停在 loading，转圈转到用户关掉面板为止
      let loaders: typeof import('./model-loaders') | null = null
      try {
        loaders = await import('./model-loaders')
      } catch (cause) {
        if (cancelled) return
        report({
          level: 'error',
          code: 'module-load',
          title: DIAGNOSTIC_TITLES['module-load'],
          detail: messageOf(cause),
        })
        setPhase('error')
        setError({ text: messageOf(cause) })
        return
      }
      if (!loaders) return
      try {
        const loaded = await loaders.loadModelFile(bytes, name, {
          renderer: scene.getRenderer(),
          // 非 glTF 的贴图是异步到的：到齐后补画一帧（当前模型已被换掉也无害）
          onLateChange: () => scene.requestRender(),
          // 模型旁边的贴图（FBX / DAE / 3DS / WRL）：没有这个路径就只剩纯色
          path,
          // 贴图缺失 / 过大 / 失效槽被移除：全部进异常日志（`model-diagnostics.ts`）
          report,
        })
        if (cancelled) {
          // 这一轮已经被换掉 / 卸载：blob URL 不留着等泄漏
          loaded.dispose?.()
          return
        }
        // 换模型：上一份的贴图 URL 现在可以放了（纹理图像已在显存 / 内存里解码完）
        releaseRef.current?.()
        releaseRef.current = loaded.dispose ?? null
        scene.setModel(loaded.object, loaded.animations, report)
        const nextStats = scene.getStats()
        setStats(nextStats)
        // 一个网格都没有（只有灯 / 空组）：画面就是空舞台，得说一句
        if (nextStats && nextStats.meshes === 0) {
          report({
            level: 'warning',
            code: 'empty-mesh',
            title: DIAGNOSTIC_TITLES['empty-mesh'],
          })
        }
        setFormat(loaded.format.toUpperCase())
        setTextures(loaded.textures ?? null)
        setClips(
          loaded.animations.map((clip, index) => ({
            name: clip.name || `${t('动画')} ${index + 1}`,
            duration: clip.duration,
          })),
        )
        // 场景那边有动画就自动播第一个（`setModel` 里做的），这里同步选中项
        setClipIndex(loaded.animations.length > 0 ? 0 : -1)
        setPhase('ready')
      } catch (cause) {
        if (cancelled) return
        const code = cause instanceof loaders.ModelLoadError ? cause.code : undefined
        report(loadFailureDiagnostic(code, messageOf(cause)))
        setPhase('error')
        setError({ code, text: messageOf(cause) })
      }
    })()
    return () => {
      cancelled = true
      // 卸载 / 换模型：让这一轮的迟到回调彻底失效（之后没有任何合法的上报方）
      sessionRef.current += 1
      // 卸载（或换文件）：这一份模型的贴图 blob URL 一起放掉
      releaseRef.current?.()
      releaseRef.current = null
    }
  }, [bytes, name, path, sceneReady])

  // 4) 开关同步到场景（场景还没建好时先攒着，建好后这次也会跑一遍）
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setWireframe(options.wireframe)
    scene.setGrid(options.showGrid)
    scene.setAxes(options.showAxes)
    scene.setAutoRotate(options.autoRotate)
    scene.setModelLights(options.useModelLights)
  }, [options, sceneReady])

  const toggle = useCallback((key: keyof ViewOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const onPresetChange = useCallback((id: string) => {
    // 只写 store：本实例与其它开着的预览都通过 `useModelPresetId` 跟随，
    // 场景统一由 `[presetId, sceneReady]` 那个 effect 应用（不在这里直接调 `applyPreset`，路径只留一条）
    setModelPresetId(id)
  }, [])

  const onClipChange = useCallback((value: number) => {
    setClipIndex(value)
    const scene = sceneRef.current
    if (!scene) return
    if (value < 0) scene.stopAnimations()
    else scene.playAnimation(value)
  }, [])

  const onScreenshot = useCallback(() => {
    const url = sceneRef.current?.screenshot()
    if (!url) {
      // 容器 0 尺寸（标签被切走）时截出来是空图：不弹空文件，但记一条
      pushDiagnostic({
        level: 'warning',
        code: 'screenshot',
        title: DIAGNOSTIC_TITLES.screenshot,
      })
      return
    }
    // 用户取消另存为会返回空串，那不是失败：只有抛错才提示
    void saveImageAs(url, `${name.replace(/\.[^.]+$/, '') || 'model'}-preview`).catch(() =>
      showToast(t('保存失败'), 2000),
    )
  }, [name, pushDiagnostic])

  const heading =
    error.code === 'unsupported' ? t('暂不支持该模型格式') : t('无法解析这个模型')
  /** 徽标数的是**条目**（一条反复出现仍是一件事）；图标颜色只跟最严重的那一级走 */
  const counts = countDiagnostics(diagnostics)
  const logTitle =
    counts.total === 0 ? t('异常日志') : tpl('异常日志（$__n__ 条）', { n: counts.total })

  return (
    <div className="wfp-model">
      <div className="wfp-model-bar">
        <Select
          className="wfp-model-select"
          dropdownClassName="wfp-model-dropdown"
          value={presetId}
          options={MODEL_PRESETS.map((preset) => ({
            value: preset.id,
            label: t(preset.label),
          }))}
          width={70}
          onChange={(value) => onPresetChange(String(value))}
        />
        {clips.length > 0 && (
          <Select
            className="wfp-model-select"
            dropdownClassName="wfp-model-dropdown"
            value={clipIndex}
            width={120}
            options={[
              { value: -1, label: t('停止') },
              ...clips.map((clip, index) => ({ value: index, label: clip.name })),
            ]}
            onChange={(value) => onClipChange(Number(value))}
          />
        )}
        <span className="wfp-spacer" />
        <button
          type="button"
          className={`wfp-model-toggle${options.wireframe ? ' is-active' : ''}`}
          title={t('线框')}
          aria-pressed={options.wireframe}
          onClick={() => toggle('wireframe')}>
          {t('线框')}
        </button>
        <button
          type="button"
          className={`wfp-model-toggle${options.showGrid ? ' is-active' : ''}`}
          title={t('网格')}
          aria-pressed={options.showGrid}
          onClick={() => toggle('showGrid')}>
          {t('网格')}
        </button>
        <button
          type="button"
          className={`wfp-model-toggle${options.showAxes ? ' is-active' : ''}`}
          title={t('坐标轴')}
          aria-pressed={options.showAxes}
          onClick={() => toggle('showAxes')}>
          {t('坐标轴')}
        </button>
        <button
          type="button"
          className={`wfp-model-toggle${options.autoRotate ? ' is-active' : ''}`}
          title={t('自动旋转')}
          aria-pressed={options.autoRotate}
          onClick={() => toggle('autoRotate')}>
          {t('自动旋转')}
        </button>
        <button
          type="button"
          className={`wfp-model-toggle${options.useModelLights ? ' is-active' : ''}`}
          title={t('使用模型自带的灯光')}
          aria-pressed={options.useModelLights}
          onClick={() => toggle('useModelLights')}>
          {t('模型灯光')}
        </button>
        <button
          type="button"
          className="wfp-model-toggle"
          title={t('重置视图')}
          disabled={phase !== 'ready'}
          onClick={() => sceneRef.current?.resetView()}>
          {t('重置视图')}
        </button>
        <button
          type="button"
          className="wfp-model-toggle"
          title={t('截图')}
          disabled={phase !== 'ready'}
          onClick={onScreenshot}>
          {t('截图')}
        </button>
        <button
          type="button"
          className={`wfp-model-toggle${infoOpen ? ' is-active' : ''}`}
          title={t('模型信息')}
          aria-pressed={infoOpen}
          onClick={() => setInfoOpen((open) => !open)}>
          {t('模型信息')}
        </button>
        {/* 异常日志：加载 / 解析 / 贴图的警告与错误都在这里（徽标 = 警告 + 错误条数）。
            不放 `disabled`：模型失败了更要能点开看原因 */}
        <button
          type="button"
          className={`wfp-model-log-btn${logOpen ? ' is-active' : ''}${
            counts.errors > 0 ? ' is-error' : counts.warnings > 0 ? ' is-warning' : ''
          }`}
          title={logTitle}
          aria-label={logTitle}
          aria-pressed={logOpen}
          onClick={() => setLogOpen((open) => !open)}>
          <AlertSvg />
          {counts.total > 0 && (
            <span className="wfp-model-log-badge">
              {counts.total > 99 ? '99+' : counts.total}
            </span>
          )}
        </button>
      </div>

      <div
        className="wfp-model-stage"
        // 演出区底色跟着预设走：否则选「灰白」时首帧前会在深色底上闪一下
        style={{ background: modelPresetOf(presetId).background }}>
        {/* 画布容器：尺寸为 0（标签被切走）时 ModelScene 自己停渲染；
            模型没解析完时先藏起来（`visibility` 不改布局，量到的尺寸照旧） */}
        <div
          ref={holderRef}
          className={`wfp-model-canvas${phase === 'loading' ? ' is-loading' : ''}`}
        />

        {phase === 'loading' && (
          <div className="wfp-model-status">
            <LoadingIcon />
            <span>{t('正在加载模型…')}</span>
          </div>
        )}

        {phase === 'error' && (
          <div className="wfp-model-status is-error">
            <p>{heading}</p>
            <p className="wfp-hint-detail">{error.text}</p>
            <button type="button" className="wfp-action" onClick={onOpenInSystem}>
              {t('在系统程序中打开')}
            </button>
          </div>
        )}

        {infoOpen && phase === 'ready' && stats && (
          <dl className="wfp-model-info">
            <div>
              <dt>{t('格式')}</dt>
              <dd>{format}</dd>
            </div>
            <div>
              <dt>{t('大小')}</dt>
              <dd>{formatBytes(bytes.byteLength)}</dd>
            </div>
            <div>
              <dt>{t('网格')}</dt>
              <dd>{stats.meshes}</dd>
            </div>
            <div>
              <dt>{t('三角形')}</dt>
              <dd>{stats.triangles.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('顶点')}</dt>
              <dd>{stats.vertices.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('材质')}</dt>
              <dd>{stats.materials}</dd>
            </div>
            {textures && (
              <div>
                <dt>{t('贴图')}</dt>
                {/* 找到的 / 引用到的：少了就是磁盘上没有那几个文件（模型仍然可以看） */}
                <dd>
                  {textures.found} / {textures.total}
                </dd>
              </div>
            )}
            <div>
              <dt>{t('尺寸')}</dt>
              <dd>
                {stats.size.x.toFixed(2)} × {stats.size.y.toFixed(2)} ×{' '}
                {stats.size.z.toFixed(2)}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {/* 弹窗自己 portal 到 body：面板有层叠上下文 / overflow，fixed 遮罩留在里面会被裁掉 */}
      <ModelLogModal
        visible={logOpen}
        entries={diagnostics}
        onClose={() => setLogOpen(false)}
        onClear={() => setDiagnostics([])}
      />
    </div>
  )
}
