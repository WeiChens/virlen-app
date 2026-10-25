/**
 * ModelView — 右侧面板里的 3D 模型预览（three）。
 *
 * 五条口径：
 * 1. **three 只在打开模型时才下载**：本组件静态 import 的只有纯数据（`model-presets`），
 *    场景管理器与加载器都是 `import()` —— 否则一个 600KB 的库会进主包（pdfjs 同一手法）。
 * 2. **字节由面板给**（`workspace-file-service` 已过安全校验与体积上限）：这里不读盘、不造 URL。
 * 3. **失败给两层信息**：一句人话（`t('无法解析这个模型')` / 外部资源 / 不支持的格式）
 *    + 库抛的原文（排查用，不抢注意力），并留一个「在系统程序中打开」的出口。
 * 4. **标签切走不卸载**（`side-panel` 只切显隐）：场景仍然活着，`ModelScene` 自己在 0 尺寸时
 *    停止渲染 —— 所以这里不需要（也不能）在隐藏时重建 WebGL 上下文。
 * 5. **截图走「另存为」对话框**：与应用里图片另存的同一条路（`saveImageAs`），
 *    浏览器 dev 环境自动退化成下载。
 * 6. **解析完成前只给转圈**：画布靠 `visibility` 藏起来（不动布局，ResizeObserver 量到的尺寸不变），
 *    否则会先看到空舞台上的网格 / 坐标轴，模型再一块块补上 —— 即「边加载边显示」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import Select from '@/ui/components/shared/Select'
import { saveImageAs } from '@/utils/clipboard'
import {
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
  modelPresetOf,
} from './model-presets'
import type { ModelScene, ModelStats } from './model-scene'
import type { ModelLoadErrorCode } from './model-loaders'
import LoadingIcon from './loading-icon'

interface Props {
  /** 模型原始字节（调用方已读过安全校验与体积上限） */
  bytes: Uint8Array
  /** 文件名（判定扩展名 / 截图默认名都用它） */
  name: string
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

export default function ModelView({ bytes, name, onOpenInSystem }: Props) {
  const holderRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<ModelScene | null>(null)
  /** 预设选中值同时留一份 ref：场景是异步建好的，建好后要读到「此刻」选的那个 */
  const presetRef = useRef(DEFAULT_MODEL_PRESET_ID)
  const [sceneReady, setSceneReady] = useState(false)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<{ code?: ModelLoadErrorCode; text: string }>({ text: '' })
  const [stats, setStats] = useState<ModelStats | null>(null)
  /** 小写扩展名（大写显示） */
  const [format, setFormat] = useState('')
  /** 动画只留展示需要的字段：THREE.AnimationClip 不进 state */
  const [clips, setClips] = useState<{ name: string; duration: number }[]>([])
  const [clipIndex, setClipIndex] = useState(-1)
  const [presetId, setPresetId] = useState(DEFAULT_MODEL_PRESET_ID)
  const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS)
  const [infoOpen, setInfoOpen] = useState(false)

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
        scene = new ModelScene(holder)
        sceneRef.current = scene
        scene.applyPreset(modelPresetOf(presetRef.current))
        setSceneReady(true)
      } catch (cause) {
        if (cancelled) return
        // 建不出 WebGL 上下文（老驱动 / 远程桌面）：当成「无法解析」并把原文给出来
        setPhase('error')
        setError({ text: messageOf(cause) })
      }
    })()
    return () => {
      cancelled = true
      sceneRef.current = null
      scene?.dispose()
    }
  }, [])

  // 2) 解析模型：换文件（bytes 变了）或场景刚建好都会走到这里
  useEffect(() => {
    const scene = sceneRef.current
    if (!sceneReady || !scene) return
    let cancelled = false
    setPhase('loading')
    setError({ text: '' })
    setStats(null)
    setClips([])
    setClipIndex(-1)
    void (async () => {
      // 先把模块拿进来：`ModelLoadError` 要在 catch 里做 instanceof 判断，不能解构在 try 里
      const loaders = await import('./model-loaders')
      try {
        const loaded = await loaders.loadModelFile(bytes, name, {
          renderer: scene.getRenderer(),
        })
        if (cancelled) return
        scene.setModel(loaded.object, loaded.animations)
        setStats(scene.getStats())
        setFormat(loaded.format.toUpperCase())
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
        setPhase('error')
        setError({ code, text: messageOf(cause) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bytes, name, sceneReady])

  // 3) 开关同步到场景（场景还没建好时先攒着，建好后这次也会跑一遍）
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
    setPresetId(id)
    presetRef.current = id
    sceneRef.current?.applyPreset(modelPresetOf(id))
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
    if (!url) return
    // 用户取消另存为会返回空串，那不是失败：只有抛错才提示
    void saveImageAs(url, `${name.replace(/\.[^.]+$/, '') || 'model'}-preview`).catch(() =>
      showToast(t('保存失败'), 2000),
    )
  }, [name])

  const heading =
    error.code === 'unsupported' ? t('暂不支持该模型格式') : t('无法解析这个模型')

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
          title={t('用模型自带的灯光（按预览尺度归一）')}
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
    </div>
  )
}
