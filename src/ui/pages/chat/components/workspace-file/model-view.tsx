/**
 * ModelView — 右侧面板里的 3D 模型预览（three）。
 *
 * 十条口径：
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
 * 6. **加载中就把场景露出来，模型等解析完再出来**：画布全程可见 —— 解析期间看到的是空舞台的
 *    网格 / 坐标轴 + 转圈（比一块黑/白屏清楚得多）；换文件时先用 `scene.clearModel()` 清掉上一份，
 *    否则加载中画面里还是上一个模型。此外换模型 / 卸载时必须调 `LoadedModel.dispose()`：
 *    本地贴图的 blob URL 归它管。
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
 * 9. **网格列表 / 选中模式**：面板里逐行显隐 + 单独显示，画布上「选中模式」下点一下就选中。
 *    列表数据只取一次（`scene.listMeshes()`），之后显隐在本地按**纯函数**改（`model-meshes.ts`），
 *    只把差异推给场景；选中高亮归场景（`selectMesh`：穿墙可见的线框盒 + **其余网格半透明**），
 *    列表高亮归 state。
 *    **列表按模型自己的层级画成树**（分组行可折、可整组显隐）：层级来自场景采集的父级链
 *    （含无名组），折叠态只存在本组件（`collapsedGroups`），换模型时重置为「只展开第一层」——
 *    深模型四五层套娃，全展开一屏全是缩进，第一眼反而看不出结构。
 *    **「单独显示」只动相机**（`focusVisible`）：模型变换一概不碰 —— 取景重排整棵树是「加载时
 *    把模型摆进画面」的一次性动作，挑网格时再来一次，模型就离开地面且回不去了。
 *    它跟「显示全部」（`resetView`）之间的机位切换由场景**飞过去**（`moveCamera`，缓入缓出），
 *    两个方向都不硬切。
 *    退出单独显示**不能只靠列表面板**（面板关掉时就没路了）：单独显示期间详情卡里那颗
 *    「单独显示」按钮直接变成「显示全部」（`isolatedId` 非空就是单独显示态），走 `onShowAllMeshes`。
 *    选中的那一块能直接复制层级路径（`path`，不是列表里的兜底显示名）、看它自己的三角形 / 顶点 / 材质 / 尺寸。
 *    再点一次同一块（列表或画布）就是取消选中；关掉选中模式则选中项直接置空 ——
 *    高亮框、其余网格的半透明、右下角详情卡都挂在「选中」上，不置空就是一堆不能再操作的残留状态。
 * 10. **移动模式只改手感，不动数据**：WASD / Q/E 走位、按住鼠标拖动转视角、滚轮推拉，开关在「更多」
 *     菜单里（默认关）；场景挂 window 键盘监听接管指针，所以退出 / 卸载 / 窗口失焦都必须把键放掉
 *     （否则镜头自己一直走）。扳手提示写在画布上：WASD / Q/E 在界面上没有任何可见入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import Select from '@/ui/components/shared/Select'
import AlertSvg from '@/ui/components/icons/AlertSvg'
import MoreSvg from '@/ui/components/icons/MoreSvg'
import ContextMenu, { useContextMenu, type ContextMenuItem } from '@/ui/components/shared/ContextMenu'
import { copyText, saveImageAs } from '@/utils/clipboard'
import {
  MODEL_PRESETS,
  modelPresetOf,
} from './model-presets'
import { setModelPresetId, useModelPresetId } from './model-environment'
import type { ModelScene, ModelStats } from './model-scene'
import type { ModelLoadErrorCode } from './model-loaders'
import {
  allVisible,
  buildMeshRows,
  defaultCollapsedGroups,
  onlyVisible,
  withGroupVisibility,
  withVisibility,
  type MeshEntry,
  type MeshRow,
} from './model-meshes'
import {
  appendDiagnostic,
  countDiagnostics,
  loadFailureDiagnostic,
  DIAGNOSTIC_TITLES,
  type DiagnosticEntry,
  type DiagnosticInput,
} from './model-diagnostics'
import ModelLogModal from './model-log'
import MeshEyeIcon from './mesh-eye-icon'
import MeshTwistIcon from './mesh-twist-icon'
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
  /** 选中模式：画布上点一下就选中一个网格（面板里的列表始终可点） */
  selectionMode: boolean
  /** 移动模式：WASD / Q/E 走位 + 按住鼠标拖动转视角（见 `ModelScene.setMoveMode`） */
  moveMode: boolean
}

const DEFAULT_OPTIONS: ViewOptions = {
  wireframe: false,
  showGrid: true,
  // 坐标轴默认关（在「更多」菜单里开）：多数模型看的是本体，六根轴常驻只添乱
  showAxes: false,
  autoRotate: false,
  useModelLights: false,
  selectionMode: false,
  // 移动模式默认关：它改了拖动的手感（轨道 → 转头），不是所有人想要的默认行为
  moveMode: false,
}

/** 列表里的显示名：多数 FBX 子网格没有名字，用序号兜底（复制出来的就是这行字） */
function meshLabelOf(entry: MeshEntry): string {
  return entry.name || tpl('网格 $__n__', { n: entry.index + 1 })
}

/**
 * 菜单项文案：开着的开关前面打勾。
 * `ContextMenuItem` 没有「已选」状态位，而 `aria-pressed` 在这里也用不上（菜单关着）；
 * 网格 / 坐标轴在画布上一眼能看出，但「自动旋转 / 模型灯光」不看这里就无处可知。
 */
function menuLabel(on: boolean, label: string): ReactNode {
  return (
    <span className="wfp-model-menu-item">
      <span className="wfp-model-menu-check">{on ? '✓' : ''}</span>
      {label}
    </span>
  )
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
  /** 网格列表面板是否展开（与「模型信息」同一层级的浮层，不占画布高度） */
  const [meshPanelOpen, setMeshPanelOpen] = useState(false)
  /** 当前模型的网格列表：换模型时由 `scene.listMeshes()` 一次成型，显隐在本地按纯函数改 */
  const [meshes, setMeshes] = useState<readonly MeshEntry[]>([])
  const [selectedMeshId, setSelectedMeshId] = useState<string | null>(null)
  /** 折叠起来的网格分组（id 集合）：纯 UI 状态、不落盘；换模型时重置为「只展开第一层」 */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  /** 树形行：层级 / 聚合数字 / 折叠都由纯函数算（`buildMeshRows`），组件只把它画出来 */
  const meshRows = useMemo(
    () => buildMeshRows(meshes, collapsedGroups),
    [meshes, collapsedGroups],
  )
  /**
   * 正在「单独显示」的那一块（null = 没在单独显示）。
   * 它决定工具栏上那个「显示全部」出不出现 —— 面板关掉时它是唯一的退路（不能只靠面板里的按钮）。
   */
  const [isolatedId, setIsolatedId] = useState<string | null>(null)
  /** 「更多」菜单（网格 / 坐标轴 / 自动旋转 / 模型灯光 / 截图 都收在里面） */
  const more = useContextMenu()
  const moreBtnRef = useRef<HTMLButtonElement>(null)
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
        // 画布点选：场景先把高亮挂上，再把 id 通知这里（列表的选中行跟上）
        scene.setMeshPickHandler(setSelectedMeshId)
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
    // 网格列表也跟着作废：旧列表的 id 指向上一份模型的对象
    setMeshes([])
    setSelectedMeshId(null)
    setIsolatedId(null)
    setCollapsedGroups(new Set())
    // 画布不藏了（加载期间露的是空舞台）：上一份模型要先清掉，否则换文件时画面里还是旧的那个
    scene.clearModel()
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
        // 网格列表与「id ↔ 对象」映射都在这一步建好（之后显隐 / 点选才有对象可落）
        const nextMeshes = scene.listMeshes()
        setMeshes(nextMeshes)
        // 树形列表默认只展开第一层（深模型的四五层套娃全展开 = 一屏全是缩进）
        setCollapsedGroups(defaultCollapsedGroups(nextMeshes))
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
    scene.setSelectionMode(options.selectionMode)
    // 放在最后：`setAutoRotate` 要看得到当前的移动模式（两者抢同一个轨道开关）
    scene.setMoveMode(options.moveMode)
  }, [options, sceneReady])

  // 5) 关掉选中模式 = 退出「挑网格」：选中项一并置空（高亮框 / 其余网格的半透明 / 详情卡都跟着收掉）。
  //    只跟 `selectionMode` 一项：列表面板的点选不受选中模式限制，切别的开关不能把选中打掉。
  useEffect(() => {
    if (options.selectionMode) return
    setSelectedMeshId(null)
    sceneRef.current?.selectMesh(null)
  }, [options.selectionMode])

  const toggle = useCallback((key: keyof ViewOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  /**
   * 「更多」菜单的展开位置取自按钮本身（右下角对齐）—— 不是鼠标事件，所以走 `openAtPoint`；
   * `anchorElement` 让「再点一次」走 toggle（否则 mousedown 先关、click 又开，看着像点不动）。
   */
  const toggleMoreMenu = useCallback(() => {
    if (more.state) {
      more.close()
      return
    }
    const rect = moreBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    more.openAtPoint({ x: rect.right, y: rect.bottom + 4 }, undefined)
  }, [more])

  /** 菜单项：五个低频开关 + 截图（模型没就绪时置灰） */
  function moreItems(): ContextMenuItem[] {
    return [
      {
        key: 'move',
        label: menuLabel(options.moveMode, t('移动模式')),
        onClick: () => toggle('moveMode'),
      },
      {
        key: 'grid',
        label: menuLabel(options.showGrid, t('网格')),
        onClick: () => toggle('showGrid'),
      },
      {
        key: 'axes',
        label: menuLabel(options.showAxes, t('坐标轴')),
        onClick: () => toggle('showAxes'),
      },
      {
        key: 'rotate',
        label: menuLabel(options.autoRotate, t('自动旋转')),
        // 自动旋转是轨道绕目标点公转，移动模式接管了镜头（同一条开关，开两个只会打架）
        disabled: options.moveMode,
        onClick: () => toggle('autoRotate'),
      },
      {
        key: 'lights',
        label: menuLabel(options.useModelLights, t('模型灯光')),
        onClick: () => toggle('useModelLights'),
      },
      {
        key: 'screenshot',
        label: t('截图'),
        disabled: phase !== 'ready',
        onClick: onScreenshot,
      },
    ]
  }

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

  /** 选中 / 取消选中：面板点选与画布点选都落到这里（高亮归场景，列表高亮归 state） */
  const onSelectMesh = useCallback((id: string | null) => {
    setSelectedMeshId(id)
    sceneRef.current?.selectMesh(id)
  }, [])

  /**
   * 可见性变更统一走这里：**只把真正变了的行**推给场景。
   * 一个 500 网格的模型「单独显示」会翻 499 行，逐行都调 `setMeshVisible` 等于刷 499 次渲染请求。
   */
  const commitMeshes = useCallback(
    (next: readonly MeshEntry[]) => {
      if (next === meshes) return
      const scene = sceneRef.current
      if (scene) {
        const before = new Map(meshes.map((entry) => [entry.id, entry.visible]))
        for (const entry of next) {
          if (before.get(entry.id) !== entry.visible) scene.setMeshVisible(entry.id, entry.visible)
        }
      }
      setMeshes(next)
    },
    [meshes],
  )

  const onToggleMesh = useCallback(
    (entry: MeshEntry) => {
      const visible = !entry.visible
      // 藏掉当前选中的那一个：选中与高亮一起收掉（否则画面上留一个套着空气的框）
      if (!visible && selectedMeshId === entry.id) onSelectMesh(null)
      // 手动改显隐就退出了「只留这一块」的状态：工具栏那个「显示全部」跟着收掉
      setIsolatedId(null)
      commitMeshes(withVisibility(meshes, entry.id, visible))
    },
    [commitMeshes, meshes, onSelectMesh, selectedMeshId],
  )

  /** 折叠 / 展开一组：只动折叠态，不碰显隐（藏起来是旁边那只眼睛的事） */
  const onToggleGroupCollapsed = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /**
   * 整组显隐：全亮着 → 一起藏；有藏着的（含「一半亮」的混合态）→ 一起点亮。
   * 藏的正好是当前选中的那一块时，选中与高亮一起收掉（否则画面上留一个套着空气的框）。
   */
  const onToggleGroup = useCallback(
    (row: MeshRow) => {
      if (row.type !== 'group') return
      const visible = row.visible !== true
      const hidesSelected =
        !!selectedMeshId &&
        (meshes
          .find((entry) => entry.id === selectedMeshId)
          ?.parents.some((parent) => parent.id === row.id) ??
          false)
      if (!visible && hidesSelected) onSelectMesh(null)
      // 手动改显隐就退出了「只留这一块」的状态（同逐网格显隐）
      setIsolatedId(null)
      commitMeshes(withGroupVisibility(meshes, row.id, visible))
    },
    [commitMeshes, meshes, onSelectMesh, selectedMeshId],
  )

  const onIsolateMesh = useCallback(
    (id: string) => {
      commitMeshes(onlyVisible(meshes, id))
      onSelectMesh(id)
      setIsolatedId(id)
      // 只留这一块 → 顺手把它拉到画面里（不然它常常只是角落里一小点）。
      // 用 `focusVisible` 而不是 `frameObject`：后者会重新缩放 / 平移整棵树，
      // 模型一旦被摆到别处就回不去（「显示全部」之后沉进地板）。挑网格只该动相机。
      sceneRef.current?.focusVisible()
    },
    [commitMeshes, meshes, onSelectMesh],
  )

  /**
   * 「显示全部」：全部亮起来，并把镜头收回全模型（单独显示时相机是贴着那一块放大的）。
   * 面板里的「显示全部」、工具栏里单独显示期间的「显示全部」、详情卡的「取消单独显示」都走它 ——
   * 「退出单独显示」必须**不依赖列表面板**：面板关掉时只有这里能退回去（用户实测抱怨过被锁住）。
   */
  const onShowAllMeshes = useCallback(() => {
    setIsolatedId(null)
    commitMeshes(allVisible(meshes))
    // `resetView` 从加载时的原始变换重算取景：位置与加载时一字不差（已经有隐藏网格也一样，
    // 它不看显隐），所以这里只可能是「镜头回来」，不会是「模型又挪了一次」
    sceneRef.current?.resetView()
  }, [commitMeshes, meshes])

  const onCopyMeshPath = useCallback((entry: MeshEntry) => {
    // 复制的是 `path`（`GEO-wheel_FL > GEO-wheel_FL_1`）：贴回导出工具 / 脚本里能直接对回那一层，
    // 而「网格 3」只是列表里的兜底显示名，出了这个面板再无可认之处
    void copyText(entry.path).then((ok) =>
      showToast(ok ? t('已复制路径到剪贴板') : t('复制失败'), 1600),
    )
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
  const selectedMesh = meshes.find((entry) => entry.id === selectedMeshId) ?? null
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
          className={`wfp-model-toggle${options.selectionMode ? ' is-active' : ''}`}
          title={t('点击画布上的网格即可选中')}
          aria-pressed={options.selectionMode}
          onClick={() => toggle('selectionMode')}>
          {t('选择')}
        </button>
        <button
          type="button"
          className={`wfp-model-toggle${meshPanelOpen ? ' is-active' : ''}`}
          title={t('网格列表')}
          aria-pressed={meshPanelOpen}
          onClick={() => setMeshPanelOpen((open) => !open)}>
          {t('网格列表')}
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
          className={`wfp-model-toggle${infoOpen ? ' is-active' : ''}`}
          title={t('模型信息')}
          aria-pressed={infoOpen}
          onClick={() => setInfoOpen((open) => !open)}>
          {t('模型信息')}
        </button>
        {/* 异常日志：加载 / 解析 / 贴图的警告与错误都在这里（徽标 = 警告 + 错误条数）。
            **没异常就完全不渲染**：平时没事的工具栏不该常年挂一个点不进去的图标（
            模型失败时一定有诊断上报，所以“出事了没入口”这种情况不会出现）。 */}
        {counts.total > 0 && (
          <button
            type="button"
            className={`wfp-model-log-btn${logOpen ? ' is-active' : ''}${
              counts.errors > 0 ? ' is-error' : ' is-warning'
            }`}
            title={logTitle}
            aria-label={logTitle}
            aria-pressed={logOpen}
            onClick={() => setLogOpen((open) => !open)}>
            <AlertSvg />
            <span className="wfp-model-log-badge">
              {counts.total > 99 ? '99+' : counts.total}
            </span>
          </button>
        )}
        {/* 「更多」：面板最窄只有 360px，十来个文字按钮在 `flex-wrap` 下会折成两行把画布挤矮。
            网格 / 坐标轴 / 自动旋转 / 模型灯光 / 截图 都是低频动作，收进菜单。 */}
        <button
          ref={moreBtnRef}
          type="button"
          className={`wfp-model-more${more.state ? ' is-active' : ''}`}
          title={t('更多')}
          aria-label={t('更多')}
          aria-haspopup="menu"
          aria-expanded={!!more.state}
          onClick={toggleMoreMenu}>
          <MoreSvg />
        </button>
      </div>

      {more.state && (
        <ContextMenu
          position={more.state.position}
          placement="bottom-left"
          anchorElement={moreBtnRef.current}
          items={moreItems()}
          onClose={more.close}
        />
      )}

      <div
        className="wfp-model-stage"
        // 演出区底色跟着预设走：否则选「灰白」时首帧前会在深色底上闪一下
        style={{ background: modelPresetOf(presetId).background }}>
        {/* 画布容器：尺寸为 0（标签被切走）时 ModelScene 自己停渲染。
            **加载中也照常显示**：先看到空舞台的网格 / 坐标轴与转圈，模型解析完再“长”出来
            （模型本体由 `scene.clearModel()` + `setModel()` 控制，画布从藏不藏）。 */}
        <div ref={holderRef} className="wfp-model-canvas" />

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

        {/* 移动模式的操作提示：WASD / Q/E 在界面上没有任何可见入口，不写这一行等于让人瞎按。
            底部居中（列表在左上、信息卡在右上、选中详情在右下），不吃指针事件。 */}
        {options.moveMode && (
          <div className="wfp-model-move-hint">
            {t('WASD 移动 · Q/E 升降 · 按住鼠标拖动转视角')}
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

        {/* 网格列表：压在左上角（信息卡在右上角，两者不抢位置），列表内部滚动，画布高度不缩水 */}
        {meshPanelOpen && phase === 'ready' && (
          <div className="wfp-mesh-panel">
            <div className="wfp-mesh-head">
              <span className="wfp-mesh-title">
                {tpl('网格列表（$__n__）', { n: meshes.length })}
              </span>
              <button
                type="button"
                className="wfp-mesh-all"
                disabled={meshes.every((entry) => entry.visible)}
                onClick={onShowAllMeshes}>
                {t('显示全部')}
              </button>
            </div>

            {meshRows.length === 0 ? (
              <p className="wfp-mesh-empty">{t('这个模型里没有网格')}</p>
            ) : (
              <ul className="wfp-mesh-list">
                {meshRows.map((row) =>
                  row.type === 'group' ? (
                    <li
                      key={`group:${row.id}`}
                      className={`wfp-mesh-row wfp-mesh-group${
                        row.visible === false ? ' is-hidden' : ''
                      }${row.visible === null ? ' is-mixed' : ''}`}
                      // 缩进写行内：层级是数据自带的（`parents` 的层数），不该在 CSS 里按行号猜
                      style={{ paddingLeft: 2 + row.depth * 12 }}>
                      <button
                        type="button"
                        className={`wfp-mesh-twist${row.collapsed ? '' : ' is-open'}`}
                        title={row.collapsed ? t('展开分组') : t('折叠分组')}
                        aria-label={row.collapsed ? t('展开分组') : t('折叠分组')}
                        aria-expanded={!row.collapsed}
                        onClick={() => onToggleGroupCollapsed(row.id)}>
                        <MeshTwistIcon />
                      </button>
                      <button
                        type="button"
                        className="wfp-mesh-eye"
                        title={row.visible === false ? t('显示这一组网格') : t('隐藏这一组网格')}
                        aria-label={
                          row.visible === false ? t('显示这一组网格') : t('隐藏这一组网格')
                        }
                        aria-pressed={row.visible === false}
                        onClick={() => onToggleGroup(row)}>
                        <MeshEyeIcon open={row.visible !== false} />
                      </button>
                      {/* 组名点一下 = 折叠 / 展开（与左边箭头同一件事：整行是最省事的目标）。
                          无名组（FBX / glTF 里大量存在）用「分组 n」兜底，n 是整张列表里的序号 */}
                      <button
                        type="button"
                        className="wfp-mesh-name"
                        title={tpl('$__n__ 个网格', { n: row.meshes })}
                        onClick={() => onToggleGroupCollapsed(row.id)}>
                        {row.name || tpl('分组 $__n__', { n: row.order })}
                      </button>
                      {/* 与网格行同一列：这一组总共多重（折起来时就看这一行） */}
                      <span className="wfp-mesh-tris">{row.triangles.toLocaleString()}</span>
                    </li>
                  ) : (
                    <li
                      key={row.id}
                      // 左边多让出一个箭头宽：子网格的眼睛要与父分组的眼睛对齐
                      style={{ paddingLeft: 2 + row.depth * 12 + 14 }}
                      className={`wfp-mesh-row${
                        row.id === selectedMeshId ? ' is-selected' : ''
                      }${row.entry.visible ? '' : ' is-hidden'}`}>
                      <button
                        type="button"
                        className="wfp-mesh-eye"
                        title={row.entry.visible ? t('隐藏这个网格') : t('显示这个网格')}
                        aria-label={row.entry.visible ? t('隐藏这个网格') : t('显示这个网格')}
                        aria-pressed={!row.entry.visible}
                        onClick={() => onToggleMesh(row.entry)}>
                        <MeshEyeIcon open={row.entry.visible} />
                      </button>
                      {/* 单击 = 选中（画布上套高亮框）；再点同一行 = 取消选中；双击 = 复制路径。
                          `title` 给完整层级路径，重名网格（`车门` / `车门.001` / 两个都叫 `mesh`）靠它区分 */}
                      <button
                        type="button"
                        className="wfp-mesh-name"
                        title={`${row.entry.path} · ${t('单击选中，双击复制路径')}`}
                        onClick={() =>
                          onSelectMesh(row.id === selectedMeshId ? null : row.id)
                        }
                        onDoubleClick={() => onCopyMeshPath(row.entry)}>
                        {meshLabelOf(row.entry)}
                      </button>
                      <span className="wfp-mesh-tris">
                        {row.entry.triangles.toLocaleString()}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        )}

        {/* 选中那一块的详情：压在**右下角**（列表在左上、信息卡在右上），与列表面板开关无关 ——
            没开列表也能用画布点选（选中模式）看到这一块的统计。 */}
        {phase === 'ready' && selectedMesh && (
          <div className="wfp-mesh-detail">
            {/* 名字给 `user-select: text`：想用鼠标圈一小段也行，复制按钮只是顺手的那条路 */}
            <div className="wfp-mesh-detail-name" title={selectedMesh.path}>
              {meshLabelOf(selectedMesh)}
            </div>
            <div className="wfp-mesh-detail-path">{selectedMesh.path}</div>
            <dl>
              <div>
                <dt>{t('三角形')}</dt>
                <dd>{selectedMesh.triangles.toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t('顶点')}</dt>
                <dd>{selectedMesh.vertices.toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t('材质')}</dt>
                <dd>{selectedMesh.materials}</dd>
              </div>
              <div>
                <dt>{t('尺寸')}</dt>
                <dd>
                  {selectedMesh.size.x.toFixed(2)} × {selectedMesh.size.y.toFixed(2)} ×{' '}
                  {selectedMesh.size.z.toFixed(2)}
                </dd>
              </div>
            </dl>
            <div className="wfp-mesh-actions">
              <button
                type="button"
                className="wfp-mesh-action"
                onClick={() => onCopyMeshPath(selectedMesh)}>
                {t('复制路径')}
              </button>
              {/* 单独显示状态下这颗按钮变成「显示全部」：退出入口就在刚刚点过的地方，
                  不必先打开网格列表面板（面板关着时无路可退 —— 用户实际踩到过）。 */}
              <button
                type="button"
                className="wfp-mesh-action"
                onClick={() =>
                  isolatedId ? onShowAllMeshes() : onIsolateMesh(selectedMesh.id)
                }>
                {isolatedId ? t('显示全部') : t('单独显示')}
              </button>
              <button
                type="button"
                className="wfp-mesh-action"
                onClick={() => onSelectMesh(null)}>
                {t('取消选中')}
              </button>
            </div>
          </div>
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
