/**
 * ModelScene — 3D 模型预览的 three 场景封装（框架无关：不 import React，不做任何 DOM 结构决策）。
 *
 * 与参考实现 `C:\code\demo\3d-preview\src\lib\SceneManager.ts` 的差别（刻意砍掉的）：
 * 大气散射天空、夜空穹顶、程序化草地 / 沙地 / 棋盘地面纹理 —— 那是观赏性背景，值大约 500 行代码；
 * 面板只有几百像素宽，真正影响「看清模型」的是这几件事，都保留了：
 * PMREM 环境反射（金属 / 粗糙材质没它是一片死灰）、半球光 + 主光 + 补光、接收阴影的地面、
 * 网格 / 坐标轴、自动取景、线框、动画、统计。
 *
 * 四条实现口径：
 * 1. **按需渲染**：没有动画 / 自动旋转 / 阻尼衰减时渲染循环自己停（`rafId = 0`）——
 *    一直跑 rAF 会让一个静止的面板白吃一整个核；
 * 2. **容器尺寸为 0 就不画**（切到别的标签时 `.side-panel-pane[hidden]` 正是这个状态）：
 *    否则隐藏标签会按 0×0 渲染，切回来是一帧被拉伸的旧画面；
 * 3. **重复取景不会越缩越小**：每次 `frameObject()` 先把根节点的原始变换放回去再算 ——
 *    直接在当前姿态上乘缩放，第二次「重置视图」就会把模型再缩一半（参考实现有这个坑）；
 *    取景的输入也只由模型本身决定（不含网格显隐），否则每点一次都把整棵树重排一遍，
 *    模型会一步步离开地面 —— 贴到某一块的活儿归 `focusVisible()`（只动相机）。
 * 4. **必须 dispose**：几何 / 材质 / 纹理 / 环境贴图 / renderer 全放掉。标签关掉即卸载，
 *    一个 5MB 的 glb 开关几次就能把显存吃干净。
 * 5. **网格列表只碰「独立对象」**：显隐直接改 `visible`，选中高亮用 `BoxHelper`（穿墙可见的线框盒），
 *    都不改模型材质 —— 材质是共享的（glTF 大量共享），改一处会连带一片；
 *    「非选中半透明」与线框共用**同一条**材质替身通路（`applyMaterials`），各写一套会互相盖掉替身、
 *    还把原件漏成没人释放。树形列表的层级也在这里采集（`listMeshes()` 给每一层发 `node-n`），
 *    面板只拿它拼树，**不自己再去走一遍 three 的对象树**。
 * 6. **换机位要飞过去，不要硬切**：`frameObject` / `focusVisible` 只管算落点，真正的移动统一走
 *    `moveCamera`（`animate` 时逐帧缓入缓出插值；用户一按轨道就放弃飞行，把手感交回去）——
 *    各自 `camera.position.copy()` 会让「单独显示 ↔ 显示全部」变成一帧跳变，像换了张图。
 * 7. **换场景预设要淡过去**：颜色 / 灯光 / 曝光按 `PRESET_FADE_MS` 插值（起点读**当前实际值**，
 *    中途再切能从半路接上）；环境贴图立刻切（换的是整张 PMREM，插不了值），
 *    网格配色新旧两份对淡（颜色烘在顶点色里，改色只能重建）。
 * 8. **移动模式是「第一人称走位」，不沿用轨道公转**：WASD 在**水平面**上平移、Q/E 竖直升降
 *    （速度 = 主体最长边 / 2 每秒，按住会一直加速，只有 A/D 左右平移不加速），
 *    按住鼠标拖动改的是**视线方向**（把 `target` 绕着相机转，不是绕模型转一圈）。
 *    不另存 yaw / pitch —— 每次都从 `position → target` 现算，所以飞行（重置视图 / 单独显示）
 *    结束后朝向天然还是对的，不用再同步一份平行状态。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { ModelPreset } from './model-presets'
import { subjectSpan, type BoxSpan } from './model-framing'
import { DIAGNOSTIC_TITLES, type DiagnosticReport } from './model-diagnostics'
import {
  buildMeshEntries,
  MESH_PARENT_ID_PREFIX,
  type MeshEntry,
  type MeshKind,
  type MeshParent,
  type MeshSource,
} from './model-meshes'

/** 预览的可视化选项（工具栏那几个开关） */
export interface ModelViewOptions {
  wireframe: boolean
  showGrid: boolean
  showAxes: boolean
  autoRotate: boolean
  /** 用模型自带的 punctual 灯（glTF `KHR_lights_punctual`），默认关，见 `applyModelLights` */
  useModelLights: boolean
  /** 选中模式：画布上「点一下就选中一个网格」，关掉则只剩拖动视角 */
  selectionMode: boolean
  /** 移动模式：WASD / Q/E 走位 + 按住鼠标拖动转视角（见 `setMoveMode`） */
  moveMode: boolean
}

/** 模型信息（尺寸是**模型自身单位**下的包围盒，不是被自动取景缩放后的） */
export interface ModelStats {
  triangles: number
  vertices: number
  meshes: number
  materials: number
  size: THREE.Vector3
}

/** 自动取景的目标尺寸：把最长边缩到这么多个「单位」，与相机距离同一量级 */
const FIT_SIZE = 2.5

/**
 * 模型自带灯在「主体中心」处的等效辐照度上限：与预览自己的主光（sun 2.0~2.2）同量级。
 * 见 `applyModelLights` 为什么必须归一。
 */
const MODEL_LIGHT_CAP = 2

/** 模型自带的一盏灯：记下作者标定的强度，开关 / 重新取景时从它算起 */
interface ModelLight {
  light: THREE.Light
  intensity: number
  /** 点光 / 聚光：辐照度按距离平方衰减，缩放场景后必须重算 */
  attenuates: boolean
}

/**
 * 统计用的最小「可画对象」视图：网格 / 点云 / 线（`Mesh.isMesh`、`Points.isPoints`、`Line.isLine`）。
 * 不能用 `THREE.Mesh` 断言：`.pcd` 返回的是 `Points`，两者交叉类型里没有 `isLine`。
 */
interface DrawableLike {
  isMesh?: boolean
  isPoints?: boolean
  isLine?: boolean
  geometry?: THREE.BufferGeometry
  material?: THREE.Material | THREE.Material[]
}

/** 选中高亮的颜色：它要穿墙可见，与任何场景预设都不该撞色 */
const HIGHLIGHT_COLOR = 0x3b82f6

/**
 * 「非选中网格」的不透明度：选中一个网格后，其余网格退成半透明（而不是藏起来）——
 * 留着它们当参照，才看得出选中的这块在模型的哪个位置。
 * 再小就完全看不见了（尤其是本来就深色的模型），0.25 实测能看见轮廓又不会抢眼。
 */
const DIM_OPACITY = 0.25

/** 按下 → 抬起的位移超过这么多像素就算「转视角」，不算点选（`OrbitControls` 的拖动很轻易超过它） */
const PICK_SLOP = 4

/**
 * 点云 / 线的命中半径：预览把整棵模型缩到最长边 2.5 个单位，而 `Raycaster` 对这两种对象的
 * 默认阈值是 1 —— 不收紧的话「点哪都可能命中」最近的点云。
 */
const PICK_THRESHOLD = 0.05

/**
 * 接收阴影的地面的高度（几何上让开 0.001）：默认 0 时它与网格线（y = 0）、模型底面
 * **三点共面**，深度值一模一样 → 网格线在模型底下闪、底面一条条缝（z-fighting）。
 *
 * ⚠️ 但**几何偏移只能算第一道**：深度精度随距离平方衰减（near 0.01 / far 5000 时，
 * 10 单位处一个深度步长约 6e-4，20 单位处已到 2.4e-3 —— 比 0.001 还大），所以画面 
 * 远端必然还会打 —— 真正兜底的是地面材质的 `polygonOffset`（见构造函数）。
 */
const GROUND_Y = -0.001

/** 网格的尺寸 / 分度（同尺寸同分度才能「新旧两份对淡」，见 `startGridFade`） */
const GRID_SIZE = 20
const GRID_DIVISIONS = 40
/** 网格线的基础透明度：淡入淡出都在它上面乘系数 */
const GRID_OPACITY = 0.6

/**
 * 场景预设的过渡时长（毫秒）：换主题是背景 / 灯光 / 曝光的整体渐变，
 * 比相机飞行（450）短一档 —— 它不该有「等镜头」的感觉，但也不能硬切（一帧从深色跳到灰白很刺眼）。
 */
const PRESET_FADE_MS = 320

/**
 * 相机飞行的时长（毫秒）：450 是「看得出在动」与「不挡手」的折中 ——
 * 再长一点，连点两下「单独显示 / 显示全部」就得排队等镜头。
 */
const CAMERA_FLIGHT_MS = 450

/**
 * 世界上方向：走位与转视角都要它。共用一份的原因不是省内存，是**绝不能被就地改写** ——
 * `applyAxisAngle` / `crossVectors` 都只读轴向量，拿它当临时变量一次就会污染全局。
 */
const WORLD_UP = new THREE.Vector3(0, 1, 0)

/**
 * 轨道相机允许的最大极角（相机相对目标点）：0.495π 让相机略高于目标点、不钻到地面以下。
 * 移动模式要临时放开（否则**抬头**会被它吞掉，见 `setMoveMode`）。
 */
const MAX_POLAR_ANGLE = Math.PI * 0.495

/**
 * 移动模式的走位速度 = **主体最长边 / 2 每秒**（`subjectLength` 在 `frameObject` 里随取景记下）：
 * 模型大就走得快、小就慢。原本给的是「每单位视距 1.5 倍」，实测太快（初始视距约 5 → 7.5 单位/秒，
 * 两三秒就穿过整个网格）。
 */
const MOVE_SPEED_DIVISOR = 2

/** 走位速度的下限：退化模型（最长边趋 0）不能让按键完全不动 */
const MOVE_MIN_SPEED = 0.05

/**
 * 加速斜率：按住每过 1 秒，走位速度在**基础速度**（主体最长边 / 2 每秒）上再加这么多倍。
 * **不设「全速」** —— 按住就一直加速：0.5 秒 ≈ 1.6×、2 秒 ≈ 3.4×、5 秒 ≈ 7×。
 * 用线性增长而不是指数：按得再久也只是「更快」，不会几秒内飞到天边。
 */
const MOVE_ACCEL_PER_SECOND = 1.2

/** 移动模式的转头速度（弧度/像素）：0.005 ≈ 0.29°/px，横拖 620px 约 180°。比 FPS 略慢，拖的是看模型的镜头 */
const MOVE_LOOK_SPEED = 0.005

/** 移动模式的滚轮推拉系数：`exp(deltaY × 0.0012)`，一档滚轮（100）约 ×1.13 */
const MOVE_WHEEL_ZOOM = 0.0012

/** 移动模式下相机的最低高度（地面 y = 0、模型底面贴地）：钻到地下只剩地板背面 */
const MOVE_MIN_Y = 0.05

/** 转头限位（弧度，离两个极点）：到了极点视线与世界上方向平行，再拖会翻面 */
const MOVE_PITCH_LIMIT = 0.08

/** 走位键（`event.key` 小写后匹配）：用 `event.code` 会跟着物理键位走，AZERTY 上 W 的位置是 Z */
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e'])

/**
 * 坐标臂长：网格是 20 单位见方、模型取景后最长边只有 2.5 —— 原来给 1.2，
 * 在缩小的模型旁边几乎看不见。5 = 网格的四分之一，看得清又不抢戏。
 */
const AXES_SIZE = 5

/**
 * 反方向臂的透明度：正方向是「往哪走」，反方向只是给出对称感，
 * 同亮度会和正轴抢注意力，反而看不出哪边是正。
 */
const AXES_NEGATIVE_OPACITY = 0.35

/** 缓入缓出：线性插值看着像被谁推了一把，两头都急停 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * 键盘事件是不是落在输入框里（移动模式的 WASD 挂在 window 上，画布不一定有焦点）：
 * 不排除的话，在面板里填文件名也会把镜头开走。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || !element.tagName) return false
  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return element.isContentEditable === true
}

/**
 * 场景预设里**能插值**的那部分（颜色 / 强度 / 灯位 / 曝光）。
 * 环境贴图与网格配色不在里面：前者换的是整张 PMREM（没法插值），
 * 后者烘在顶点色里（只能新旧两份对淡，见 `startGridFade`）。
 */
interface SceneLook {
  background: THREE.Color
  ground: THREE.Color
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiIntensity: number
  sunColor: THREE.Color
  sunIntensity: number
  sunPosition: THREE.Vector3
  fillColor: THREE.Color
  fillIntensity: number
  fillPosition: THREE.Vector3
  exposure: number
}

/** 预设 → 观感（插值的终点） */
function lookOf(preset: ModelPreset): SceneLook {
  return {
    background: new THREE.Color(preset.background),
    ground: new THREE.Color(preset.ground),
    hemiSky: new THREE.Color(preset.hemi.sky),
    hemiGround: new THREE.Color(preset.hemi.ground),
    hemiIntensity: preset.hemi.intensity,
    sunColor: new THREE.Color(preset.sun.color),
    sunIntensity: preset.sun.intensity,
    sunPosition: new THREE.Vector3(...preset.sun.position),
    fillColor: new THREE.Color(preset.fill.color),
    fillIntensity: preset.fill.intensity,
    fillPosition: new THREE.Vector3(...preset.fill.position),
    exposure: preset.exposure,
  }
}

/** 两份观感之间插值：颜色在 `Color` 里存的是线性值，直接 `lerp` 就是物理上正确的过渡 */
function lerpLook(from: SceneLook, to: SceneLook, t: number): SceneLook {
  const mix = (a: number, b: number): number => a + (b - a) * t
  return {
    background: from.background.clone().lerp(to.background, t),
    ground: from.ground.clone().lerp(to.ground, t),
    hemiSky: from.hemiSky.clone().lerp(to.hemiSky, t),
    hemiGround: from.hemiGround.clone().lerp(to.hemiGround, t),
    hemiIntensity: mix(from.hemiIntensity, to.hemiIntensity),
    sunColor: from.sunColor.clone().lerp(to.sunColor, t),
    sunIntensity: mix(from.sunIntensity, to.sunIntensity),
    sunPosition: from.sunPosition.clone().lerp(to.sunPosition, t),
    fillColor: from.fillColor.clone().lerp(to.fillColor, t),
    fillIntensity: mix(from.fillIntensity, to.fillIntensity),
    fillPosition: from.fillPosition.clone().lerp(to.fillPosition, t),
    exposure: mix(from.exposure, to.exposure),
  }
}

/** 有效可见性：自己与所有祖先都 `visible` 才算看得见（藏一个组 = 整棵子树都不画） */
function isVisibleInTree(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false
  }
  return true
}

/** 一个可画对象的三角形数（点云 / 线没有三角形，给 0） */
function trianglesOf(object: DrawableLike): number {
  const geometry = object.geometry
  if (!object.isMesh || !geometry) return 0
  // 索引几何：一个三角形 = 3 个索引；非索引几何：一个三角形 = 3 个顶点
  if (geometry.index) return geometry.index.count / 3
  return (geometry.attributes.position?.count ?? 0) / 3
}

export class ModelScene {
  private readonly container: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private grid: THREE.GridHelper
  private readonly axes: THREE.AxesHelper
  /** 反方向的三个臂（`AxesHelper` 只画正方向）：同长、半透明，见构造函数 */
  private readonly axesNegative: THREE.AxesHelper
  private readonly hemi: THREE.HemisphereLight
  private readonly sun: THREE.DirectionalLight
  private readonly fill: THREE.DirectionalLight
  private readonly ground: THREE.Mesh
  private readonly groundMaterial: THREE.MeshStandardMaterial
  private readonly pmrem: THREE.PMREMGenerator
  private envTexture: THREE.Texture | null = null
  /** 缓存下来的摄影棚环境（`env: 'room'` 的预设复用同一张，切走时不释放） */
  private roomTexture: THREE.Texture | null = null
  private readonly resizeObserver: ResizeObserver

  private model: THREE.Object3D | null = null
  /** 异常上报（面板给）：取景时遇到「没有几何」这类情况要能说出来，不能只是白屏 */
  private report: DiagnosticReport | undefined
  /** 模型根节点进来时的原始变换：取景 / 重置都从它算起（口径 3） */
  private homeTransform: {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  } | null = null
  /** 模型自身单位下的包围盒尺寸（自动取景前记下来，`getStats` 报的才是真实尺寸） */
  private sourceSize: THREE.Vector3 | null = null
  /** 原始材质（线框 / 半透明替身换回去用）：按**对象**记，点云 / 线也要能压成半透明 */
  private readonly originalMaterials = new WeakMap<
    THREE.Object3D,
    THREE.Material | THREE.Material[]
  >()
  /** 当前挂在网格上的材质替身（线框 / 半透明）：每次状态变化整批重建，旧的一次性放掉 */
  private materialOverrides: THREE.Material[] = []
  /** 当前选中的对象：不为 null 时其余网格退成半透明（见 `applyMaterials`） */
  private selected: THREE.Object3D | null = null

  private mixer: THREE.AnimationMixer | null = null
  private clips: THREE.AnimationClip[] = []
  private currentAction: THREE.AnimationAction | null = null

  private readonly timer = new THREE.Timer()
  private rafId = 0
  private disposed = false
  /** 用户正按着鼠标拖轨道：拖拽期间保持渲染（阻尼衰减要靠连续帧） */
  private interacting = false
  /** 相机飞行的起终点与已用时间（见 `moveCamera`）：null = 没在飞 */
  private flight: {
    fromPosition: THREE.Vector3
    fromTarget: THREE.Vector3
    toPosition: THREE.Vector3
    toTarget: THREE.Vector3
    elapsed: number
  } | null = null
  /** 场景预设的过渡（颜色 / 灯光 / 曝光）：null = 没在过渡，见 `applyPreset` */
  private lookFade: { from: SceneLook; to: SceneLook; elapsed: number } | null = null
  /** 网格配色交叉淡入淡出：`this.grid` 是新的那份，`old` 正在淡出 */
  private gridFade: { old: THREE.GridHelper; elapsed: number } | null = null

  readonly options: ModelViewOptions = {
    wireframe: false,
    showGrid: true,
    // 坐标轴默认关：它只是辅助参照，平时让画面干净（工具栏「更多 → 坐标轴」手动开）
    showAxes: false,
    autoRotate: false,
    useModelLights: false,
    selectionMode: false,
    moveMode: false,
  }

  /** 模型自带的灯（glTF `KHR_lights_punctual`）：默认不显示，原因见 `applyModelLights` */
  private modelLights: ModelLight[] = []
  /** 网格列表的「id → 真对象」与反向映射（`listMeshes` 建）：显隐 / 选中 / 点选都靠它对上号 */
  private meshObjects = new Map<string, THREE.Object3D>()
  private meshIds = new Map<THREE.Object3D, string>()
  /** 选中高亮的线框盒（独立对象：改材质会与线框开关、共享材质打架） */
  private highlight: THREE.BoxHelper | null = null
  /** 画布点选的回调（面板给）：场景先挂好高亮，再把 id 告诉面板 */
  private pickHandler: ((id: string | null) => void) | null = null
  /** 画布上按下的位置：抬起来时用它区分「点选」与「拖视角」 */
  private pointerAt: { x: number; y: number } | null = null
  /** 移动模式（见文件头口径 8）：开着时轨道控制让位，指针与键盘都归这里管 */
  private moveMode = false
  /** 移动模式下按住的走位键（松手 / 窗口失焦都要清，否则镜头自己一直走） */
  private readonly moveKeys = new Set<string>()
  /** 走位键已连续按住多久（秒）：速度按它**一直往上加**，松手 / 键全松开就归零（下次从基础速度重新起步） */
  private moveHeld = 0
  /** 移动模式正按着鼠标转视角；`lookAt` 是上一帧的指针位置（增量转，不看绝对值） */
  private looking = false
  private lookAt: { x: number; y: number } | null = null
  private readonly raycaster = new THREE.Raycaster()
  /** 当前取景缩放出来的倍率（根节点缩放）：点光强度归一要用它 */
  private fittedScale = 1
  /** 取景后「主体中心」的世界坐标：点光在主体处的辐照度按它量 */
  private readonly subjectCenter = new THREE.Vector3()
  /**
   * 「主体」在当前场景里的**最长边**（世界单位）：移动模式的速度按它算（每秒走它的一半）。
   * 取景会把模型归一化到 `FIT_SIZE`，所以这个值来自 `frameObject` 实测而不是预设表 ——
   * 以后改取景口径 / 没取景的空舞台，速度也自动跟着对。
   */
  private subjectLength = FIT_SIZE

  /** 「重置视图」回到的相机姿态（每次取景后更新） */
  private readonly homeCamera = {
    position: new THREE.Vector3(4, 2.5, 6),
    target: new THREE.Vector3(0, 1, 0),
  }

  constructor(container: HTMLElement, report?: DiagnosticReport) {
    this.container = container
    // 场景先拿一份不跟轮次的报告：上下文丢失可能发生在第一个模型进来之前
    this.report = report
    // 隐藏标签里挂载时量到的是 0：先按兜底尺寸建上下文，ResizeObserver 会在真正显示时纠正
    const width = container.clientWidth || 640
    const height = container.clientHeight || 420

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      // 截图要 `toDataURL`：没有它，画面呈现后像素缓冲可能已被交换掉
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    // r186 已移除 `PCFSoftShadowMap`（用它会被静默降级成 PCFShadowMap 并甩一条 warn）
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    const canvas = this.renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    // 上下文丢失（显存吃紧 / 驱动重启）：画面会永久停在最后一帧，必须说出来 ——
    // 否则用户以为「模型就长这样」。不自动恢复：重新打开这个文件比半死不活的恢复稳当。
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.report?.({
        level: 'error',
        code: 'context-lost',
        title: DIAGNOSTIC_TITLES['context-lost'],
      })
    })

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#0e1116')

    // 环境反射（IBL）：PBR 材质没有它就是一片死灰，比任何一盏灯都重要
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.envTexture = this.pmrem.fromScene(room, 0.04).texture
    this.scene.environment = this.envTexture
    room.dispose()

    // near 给 0.05：深度精度与 near 成反比（见 `GROUND_Y`），而 `controls.minDistance = 0.2`
    // 保证相机永远进不到 0.05 以内，近裁面不存在“切模型”的风险
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 5000)
    this.camera.position.copy(this.homeCamera.position)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    // 贴地观察时相机钻到地面以下是常见的困惑来源：留一点下限（移动模式会临时放开，见 `setMoveMode`）
    this.controls.maxPolarAngle = MAX_POLAR_ANGLE
    this.controls.minDistance = 0.2
    this.controls.maxDistance = 200
    this.controls.target.copy(this.homeCamera.target)
    this.controls.addEventListener('start', () => {
      // 手一碰轨道就交给用户：飞行还在插值会把镜头从手上抢回去
      this.flight = null
      this.interacting = true
      this.requestRender()
    })
    this.controls.addEventListener('end', () => {
      this.interacting = false
      this.requestRender()
    })
    this.controls.addEventListener('change', () => this.requestRender())

    // 点选挂在画布上（不是 document）：面板的浮层压在画布之上，不该被这一层偷走点击
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    // 指针被系统收走（切窗口 / 触控取消）也要收尾，否则移动模式会一直按着
    canvas.addEventListener('pointercancel', this.onPointerUp)
    // 移动模式下的滚轮推拉（轨道被关后它的滚轮缩放也失效了，这里自己接手）
    canvas.addEventListener('wheel', this.onMoveWheel, { passive: false })
    // 点云 / 线的命中半径，见 `PICK_THRESHOLD`
    this.raycaster.params.Points.threshold = PICK_THRESHOLD
    this.raycaster.params.Line.threshold = PICK_THRESHOLD

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x333344, 0.6)
    this.scene.add(this.hemi)

    this.sun = new THREE.DirectionalLight(0xffffff, 2)
    this.sun.position.set(5, 8, 6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(1024, 1024)
    this.sun.shadow.camera.near = 0.5
    this.sun.shadow.camera.far = 60
    this.sun.shadow.camera.left = -6
    this.sun.shadow.camera.right = 6
    this.sun.shadow.camera.top = 6
    this.sun.shadow.camera.bottom = -6
    // 自阴影常见的一圈条纹（shadow acne）：偏移一丁点就干净
    this.sun.shadow.bias = -0.0005
    this.scene.add(this.sun)

    this.fill = new THREE.DirectionalLight(0xb0c4ff, 0.4)
    this.fill.position.set(-6, 3, -4)
    this.scene.add(this.fill)

    this.grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x3a4250, 0x232833)
    this.setGridOpacity(this.grid)
    this.scene.add(this.grid)

    this.axes = new THREE.AxesHelper(AXES_SIZE)
    this.axes.visible = this.options.showAxes
    this.scene.add(this.axes)
    // `AxesHelper` 只画 +x / +y / +z 三根，反方向得自己补：再挂一份同尺寸的，
    // 用镜像缩放（-1,-1,-1）得到三个反向臂（顶点色烘在几何里，负缩放不改颜色，
    // 红 / 绿 / 蓝仍然对得上）。
    // ⚠️ 深度测试一律**不关**：关了就直接画在模型前面（看着像浮在模型之上）。
    // −y 那根整段在地面之下，被地面挡住才是对的 —— 遮挡关系优先于「六根全露」。
    this.axesNegative = new THREE.AxesHelper(AXES_SIZE)
    this.axesNegative.scale.set(-1, -1, -1)
    const negativeAxisMaterial = this.axesNegative.material as THREE.LineBasicMaterial
    negativeAxisMaterial.transparent = true
    negativeAxisMaterial.opacity = AXES_NEGATIVE_OPACITY
    this.axesNegative.visible = this.options.showAxes
    this.scene.add(this.axesNegative)

    // 接收阴影的地面：模型「站在地上」而不是飘着，全靠它
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x15181d,
      roughness: 0.94,
      metalness: 0,
      // ⚠️ 与网格线 / 模型底面共面的唯一可靠解法：把地面在**深度缓冲**里压后一点。
      // 纯几何让开（`GROUND_Y`）在画面远端会被深度量化吃掉 —— 精度随距离平方衰减，
      // 20 单位处一个深度步长就比那 0.001 还大。`polygonOffsetUnits` 是「本像素最小可分辨
      // 深度差」的倍数，跟着当前精度自适应，所以多远都压得住（网格线是透明对象，
      // 深度测试照样生效，只是比地面后画）。
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
    })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.groundMaterial)
    this.ground.rotation.x = -Math.PI / 2
    // 网格线与模型底面都在 y = 0：地面必须让开一点，见 `GROUND_Y`
    this.ground.position.y = GROUND_Y
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    // 页面不可见时 delta 记 0（`Timer` 内建）：最小化再回来不会给动画一个跳变
    this.timer.connect(document)

    this.animate()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  // ------------------------------------------------------------------ 模型

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer
  }

  /** 换模型：会先把上一份彻底释放（几何 / 材质 / 贴图 / 线框替身） */
  setModel(
    object: THREE.Object3D,
    animations: readonly THREE.AnimationClip[],
    report?: DiagnosticReport,
  ): void {
    this.clearModel()
    this.report = report
    this.model = object
    this.homeTransform = {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    }
    object.traverse((child) => {
      const drawable = child as DrawableLike
      // 材质原件记在**所有可画对象**上：半透明强调对点云 / 线同样要生效（线框只管网格）
      if (drawable.material) this.originalMaterials.set(child, drawable.material)
      if (!drawable.isMesh) {
        // glTF 的 `KHR_lights_punctual` 会被 GLTFLoader 还原成真正的灯，跟网格一起挂在这棵树上
        if ((child as THREE.Light).isLight) {
          const light = child as THREE.Light
          this.modelLights.push({
            light,
            intensity: light.intensity,
            attenuates: !!(light as THREE.PointLight).isPointLight || !!(light as THREE.SpotLight).isSpotLight,
          })
        }
        return
      }
      const mesh = child as THREE.Mesh
      mesh.castShadow = true
      mesh.receiveShadow = true
      if (!mesh.name) mesh.name = 'mesh'
    })
    this.scene.add(object)
    this.clips = [...animations]
    this.mixer = animations.length > 0 ? new THREE.AnimationMixer(object) : null
    this.applyMaterials()
    this.frameObject()
    // 有动画就自动播第一个（与参考实现同口径：打开就能看到动起来）
    if (animations.length > 0) this.playAnimation(0)
    this.requestRender()
  }

  clearModel(): void {
    this.stopAnimations()
    this.clips = []
    this.mixer = null
    this.sourceSize = null
    this.homeTransform = null
    this.modelLights = []
    this.fittedScale = 1
    // 没有模型时按取景目标尺寸算（空舞台上走位也不该停）
    this.subjectLength = FIT_SIZE
    // 高亮框与「id ↔ 对象」映射都指向上一份模型：不清掉就是悬空引用 + 画面上一个孤儿框
    this.clearHighlight()
    this.meshObjects.clear()
    this.meshIds.clear()
    this.selected = null
    // 飞行的终点算的是上一份模型的包围盒：留着就是往一个不存在的位置飞
    this.flight = null
    if (!this.model) return
    // 线框 / 半透明开着时材质是替身：先换回原件，否则原件（连同它的贴图）永远不会被释放
    this.restoreMaterials()
    this.disposeObject(this.model)
    this.scene.remove(this.model)
    this.model = null
  }

  getClips(): THREE.AnimationClip[] {
    return this.clips
  }

  /**
   * 自动取景：主体居中、最长边缩到 `FIT_SIZE`、底部贴地，相机退到能装下它的距离。
   * 先恢复根节点原始变换再算 —— 反复「重置视图」不会把模型越缩越小（口径 3）。
   * 取景框取的是**主体**而不是整棵树：星空 / 远景散布物会把包围盒撞大好几倍（见 `model-framing.ts`）。
   */
  frameObject(animate = false): void {
    const object = this.model
    if (!object) {
      this.moveCamera(this.homeCamera.position, this.homeCamera.target, animate)
      return
    }
    if (this.homeTransform) {
      object.position.copy(this.homeTransform.position)
      object.quaternion.copy(this.homeTransform.quaternion)
      object.scale.copy(this.homeTransform.scale)
    }
    object.updateMatrixWorld(true)
    // 尺寸统计取**全部**网格（含藏起来的）：藏几个网格不该让「尺寸」变小
    const whole = new THREE.Box3().setFromObject(object)
    if (whole.isEmpty()) {
      // 有节点但没有任何几何（只有灯 / 空组）：取景无从谈起，画面就是个空舞台 —— 得说一句
      this.report?.({
        level: 'warning',
        code: 'empty-bounds',
        title: DIAGNOSTIC_TITLES['empty-bounds'],
      })
      return
    }
    // 原始尺寸（整棵树）在缩放前记下来：面板里显示的「尺寸」要是模型自己的单位
    this.sourceSize = whole.getSize(new THREE.Vector3())

    // 取景按**全部**网格算（`subjectBox` 默认不论可见性）：这才是「重置视图」的语义 ——
    // 藏了几个网格也回到加载时那个全模型视图。跟着隐藏状态走的话，点一次就重排一次整棵树，
    // 模型会一步步离开地面（实测：单独显示后再显示全部，模型沉到地板下）。
    // 要贴到某一小块的是 `focusVisible()`（只动相机）。
    const box = this.subjectBox(object) ?? whole
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())

    const maxDimension = Math.max(size.x, size.y, size.z, 1e-6)
    const scale = FIT_SIZE / maxDimension
    object.scale.multiplyScalar(scale)
    // 横向居中、底部贴地（y = 0 是地面）
    object.position.x += -center.x * scale
    object.position.y += -box.min.y * scale
    object.position.z += -center.z * scale

    this.fittedScale = object.scale.x

    const fitted = this.subjectBox(object) ?? new THREE.Box3().setFromObject(object)
    const fittedSize = fitted.getSize(new THREE.Vector3())
    const fittedCenter = fitted.getCenter(new THREE.Vector3())
    const fov = (this.camera.fov * Math.PI) / 180
    const distance =
      (Math.max(fittedSize.x, fittedSize.y, fittedSize.z) / (2 * Math.tan(fov / 2))) * 1.9
    const direction = new THREE.Vector3(1, 0.55, 1).normalize()
    const position = fittedCenter.clone().add(direction.multiplyScalar(distance))

    this.subjectCenter.copy(fittedCenter)
    this.subjectLength = Math.max(fittedSize.x, fittedSize.y, fittedSize.z, 1e-6)
    this.applyModelLights()

    // 落点从**算出来的值**记，不从 `camera.position` 读：飞行时相机还在半路上，
    // 读到的是上一份姿态 —— 之后「重置视图」就再也回不到这次取景了。
    this.homeCamera.position.copy(position)
    this.homeCamera.target.copy(fittedCenter)
    this.moveCamera(position, fittedCenter, animate)
  }

  /**
   * 主体包围盒：逐网格求包围盒，剔除尺寸离群者后并集（星空盒 / 远景散布的真正元凶）。
   *
   * `visibleOnly` 只给 `focusVisible()` 用（「单独显示」要把镜头贴到那一块）；
   * 取景（`frameObject`）**必须算全部网格**：它要重新缩放 / 平移整棵树，一旦结果依赖隐藏状态，
   * 「重置视图」就变成「按当前可见部分重新排一遍」—— 模型位置会漂，最后沉进地板。
   * 返回 null（没有任何网格）时由调用方退回整树包围盒。
   */
  private subjectBox(object: THREE.Object3D, visibleOnly = false): THREE.Box3 | null {
    // ⚠️ 必须自己刷一次矩阵：`Box3.setFromObject(mesh)` 用的是 mesh 的**父级 matrixWorld**，
    // 而父级只有 `updateMatrixWorld` 才会刷新。缩放 / 平移后不刷，拿到的就是缩放前的坐标
    // —— 表现为相机距离被 `maxDistance` 截到 200、模型缩成画面里一个小点。
    object.updateMatrixWorld(true)
    const spans: BoxSpan[] = []
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      // 手动藏起来的网格：只有显式要看「只有哪块可见」时才排除（`focusVisible`）
      if (visibleOnly && !isVisibleInTree(mesh)) return
      const box = new THREE.Box3().setFromObject(mesh)
      if (box.isEmpty()) return
      spans.push({ min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] })
    })
    const span = subjectSpan(spans)
    if (!span) return null
    return new THREE.Box3(new THREE.Vector3(...span.min), new THREE.Vector3(...span.max))
  }

  /**
   * 相机移动的唯一出口：`animate` 为真就逐帧飞过去，否则原地落位。
   *
   * 飞行期间的推理由 `animate` 每帧调 `stepFlight`（那里本来就有 delta，也负责「还在动就继续出帧」）；
   * 这里只落起点 / 终点。`animate = false` 走同步那一支（加载完成、没有模型时的回位）——
   * 加载时的取景是模型本体一次性摆进来的，镜头再慢慢飘过去只会让人以为加载没完成。
   */
  private moveCamera(position: THREE.Vector3, target: THREE.Vector3, animate: boolean): void {
    if (!animate) {
      this.flight = null
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      this.controls.update()
      this.requestRender()
      return
    }
    this.flight = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position.clone(),
      toTarget: target.clone(),
      elapsed: 0,
    }
    this.requestRender()
  }

  /** 推进一帧飞行：缓入缓出插值，到头就把控制权交还给 `controls`（清空 `flight`） */
  private stepFlight(delta: number): void {
    const flight = this.flight
    if (!flight) return
    flight.elapsed += delta * 1000
    const raw = Math.min(1, flight.elapsed / CAMERA_FLIGHT_MS)
    const t = easeInOutCubic(raw)
    this.camera.position.lerpVectors(flight.fromPosition, flight.toPosition, t)
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, t)
    if (raw >= 1) this.flight = null
  }

  /** 「重置视图」：回到全模型取景；**飞回去**而不是硬跳（与「单独显示」对称） */
  resetView(): void {
    this.frameObject(true)
  }

  /**
   * 把相机对准**当前可见**的部分（「单独显示」用它）：只动相机，**不动模型的变换**。
   *
   * 与 `frameObject` 的根本差别：后者为了取景会缩放 / 平移整棵树 —— 那是「加载后把模型摆进画面」，
   * 只该发生一次。挑网格时再摆一次，模型就离开了地面（位置、比例全变），而且回不去：
   * `homeTransform` 记的是**加载时**的原始变换，不是上一次取景后的姿态。
   * 方向沿用用户当前视角：只调远近与目标点，不把镜头甩到另一个面。
   */
  focusVisible(): void {
    const object = this.model
    if (!object) return
    const box = this.subjectBox(object, true)
    if (!box) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const fov = (this.camera.fov * Math.PI) / 180
    const distance = (Math.max(size.x, size.y, size.z) / (2 * Math.tan(fov / 2))) * 1.9
    const direction = this.camera.position.clone().sub(this.controls.target)
    if (direction.lengthSq() < 1e-6) direction.set(1, 0.55, 1)
    direction.normalize()
    // 只换相机、不动模型变换；距离被 `min` / `maxDistance` 夹住仍由每帧的 `controls.update()` 管
    this.moveCamera(center.clone().add(direction.multiplyScalar(distance)), center, true)
  }

  getStats(): ModelStats | null {
    if (!this.model) return null
    let triangles = 0
    let vertices = 0
    let meshes = 0
    const materials = new Set<THREE.Material>()
    this.model.traverse((child) => {
      // PCD 是点云（`Points`）、部分格式还会带线：它们也算一个「网格」、顶点照数，
      // 三角形只对 `Mesh` 有意义 —— 只认 `isMesh` 的话 .pcd 的信息面板是 0 / 0 / 0
      const object = child as DrawableLike
      const drawable = !!(object.isMesh || object.isPoints || object.isLine)
      if (!drawable) return
      meshes += 1
      triangles += trianglesOf(object)
      if (object.geometry?.attributes.position) {
        vertices += object.geometry.attributes.position.count
      }
      const list = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of list) if (material) materials.add(material)
    })
    return {
      triangles: Math.round(triangles),
      vertices,
      meshes,
      materials: materials.size,
      size: this.sourceSize?.clone() ?? new THREE.Vector3(),
    }
  }

  // ------------------------------------------------------------------ 网格列表

  /**
   * 网格列表（面板的「网格」面板用它）：当前模型的每一个可画对象一行，顺序 = 遍历顺序 = id 序号。
   *
   * 顺带重建「id ↔ 对象」两张映射 —— 显隐 / 选中 / 画布点选都靠它对上号，
   * 所以**换模型后必须重取一次**（`setModel` 会清空旧映射）。
   */
  listMeshes(): MeshEntry[] {
    if (!this.model) {
      this.meshObjects = new Map()
      this.meshIds = new Map()
      return []
    }
    // 取景刚把整棵树缩过：先刷矩阵，量出来的包围盒才与当前姿态一致（同 `subjectBox` 的理由）
    this.model.updateMatrixWorld(true)
    const scale = Math.max(this.fittedScale, 1e-6)
    const sources: MeshSource[] = []
    const objects: THREE.Object3D[] = []
    // 分组 id 按**遍历顺序**发（`node-0`…）：树形列表的折叠态 / 整组显隐都靠它，
    // 重取一次必须还是同一批 id。每个节点都发（网格也能当父级），深度优先先序保证
    // 用到某个可画对象时它的祖先早已发过号。
    const parentIds = new Map<THREE.Object3D, string>()
    this.model.traverse((child) => {
      if (!parentIds.has(child)) {
        parentIds.set(child, `${MESH_PARENT_ID_PREFIX}${parentIds.size}`)
      }
      const object = child as DrawableLike
      const kind: MeshKind | null = object.isMesh
        ? 'mesh'
        : object.isPoints
          ? 'points'
          : object.isLine
            ? 'line'
            : null
      if (!kind) return
      const list = Array.isArray(object.material) ? object.material : [object.material]
      const box = new THREE.Box3().setFromObject(child)
      // 除以取景缩放：面板里的尺寸要是**模型自己的单位**（与信息面板的「尺寸」同一口径）
      const size = box.isEmpty()
        ? new THREE.Vector3()
        : box.getSize(new THREE.Vector3()).divideScalar(scale)
      sources.push({
        name: child.name,
        parents: this.ancestorsOf(child, parentIds),
        kind,
        triangles: trianglesOf(object),
        vertices: object.geometry?.attributes.position?.count ?? 0,
        materials: list.filter(Boolean).length,
        size: { x: size.x, y: size.y, z: size.z },
        visible: isVisibleInTree(child),
      })
      objects.push(child)
    })
    const entries = buildMeshEntries(sources)
    this.meshObjects = new Map(entries.map((entry, index) => [entry.id, objects[index]]))
    this.meshIds = new Map(objects.map((object, index) => [object, entries[index]?.id ?? '']))
    return entries
  }

  /**
   * 从根（不含模型根节点本身）到它父级的每一层：面板里显示成「车身 > 车门」，
   * 树形列表则按 `id` 还原层级。
   *
   * **无名组也要留下一层**（`name` 为空）：过滤掉的话树会被抹平一层，子网格直接挂到祖父下面，
   * 看着像作者没分组；`path` 里的空名由 `meshPathOf` 自己滤，显示口径不受影响。
   */
  private ancestorsOf(
    child: THREE.Object3D,
    parentIds: Map<THREE.Object3D, string>,
  ): MeshParent[] {
    const chain: MeshParent[] = []
    for (let node = child.parent; node && node !== this.model; node = node.parent) {
      chain.unshift({ id: parentIds.get(node) ?? '', name: node.name })
    }
    return chain
  }

  /** 单个网格的显隐：直接落在 three 的对象上（父组也藏着时仍以父组为准） */
  setMeshVisible(id: string, visible: boolean): void {
    const object = this.meshObjects.get(id)
    if (!object || object.visible === visible) return
    object.visible = visible
    this.requestRender()
  }

  /**
   * 选中：高亮那一块，并把**其余网格压成半透明**（留着当参照，看不清才需要藏）。
   * `null` / 找不到 / 已经被藏起来 = 取消（半透明一起恢复）。
   */
  selectMesh(id: string | null): void {
    const object = id ? (this.meshObjects.get(id) ?? null) : null
    const selectable = object && isVisibleInTree(object) ? object : null
    if (this.selected !== selectable) {
      this.selected = selectable
      this.applyMaterials()
    }
    if (!selectable) {
      this.clearHighlight()
      return
    }
    if (!this.highlight || this.highlight.object !== selectable) {
      this.clearHighlight()
      const helper = new THREE.BoxHelper(selectable, HIGHLIGHT_COLOR)
      const material = helper.material as THREE.LineBasicMaterial
      // 埋在几何里面的那几条边也要看得见：关深度测试、放在最后画
      material.depthTest = false
      material.transparent = true
      helper.renderOrder = 999
      this.highlight = helper
      this.scene.add(helper)
    }
    this.highlight.update()
    this.requestRender()
  }

  private clearHighlight(): void {
    if (!this.highlight) return
    this.scene.remove(this.highlight)
    this.highlight.geometry.dispose()
    ;(this.highlight.material as THREE.Material).dispose()
    this.highlight = null
  }

  // ------------------------------------------------------------------ 选项

  /**
   * 选中模式：打开后画布上「点一下就选中一个网格」（面板里的列表始终可点，与它无关）。
   * 光标跟着变，否则用户不知道这一下是选东西还是转视角。
   */
  setSelectionMode(on: boolean): void {
    this.options.selectionMode = on
    this.syncCursor()
  }

  /**
   * 画布光标：移动模式是「抓」（按住拖 = 转视角），选中模式是十字，其余交回默认箭头。
   * 两种模式同时开着时以移动模式为准 —— 那一下拖动确实在转视角。
   */
  private syncCursor(): void {
    const style = this.renderer.domElement.style
    if (this.moveMode) style.cursor = this.looking ? 'grabbing' : 'grab'
    else style.cursor = this.options.selectionMode ? 'crosshair' : ''
  }

  /**
   * 移动模式（第一人称走位）：WASD 前后左右、Q/E 升降、按住鼠标拖动转视角。
   *
   * 为什么不沿用 `OrbitControls`：它的拖动是**绕 `target` 公转**（绕着模型转一圈），不是「转头看」；
   * 而且 `maxPolarAngle` 不许镜头低于目标点 —— 移动模式里**抬头**（把 target 抬到相机上方）
   * 会被它按球坐标吞回去。所以这里 `enabled = false` 自己接管指针，极角临时放到接近 180°
   * （「不许钻到地下」改由 `MOVE_MIN_Y` 在走位时保证），退出时全部还原。
   */
  setMoveMode(on: boolean): void {
    if (this.moveMode === on) return
    this.moveMode = on
    this.options.moveMode = on
    // 正在拖的半截手势不能跨模式带过去（否则一开就被当成正在转头）
    this.looking = false
    this.lookAt = null
    this.moveHeld = 0
    this.controls.enabled = !on
    // 自动旋转是轨道自己绕 target 公转：移动模式下它会把刚走到的位置绕掉。
    // `options.autoRotate` 不动，退出时按开关原样恢复（见 `setAutoRotate`）。
    this.controls.autoRotate = on ? false : this.options.autoRotate
    this.controls.maxPolarAngle = on ? Math.PI - MOVE_PITCH_LIMIT : MAX_POLAR_ANGLE
    if (on) {
      // 挂 window 而不是画布：画布本身不可聚焦，从菜单里开完直接按 W 也得能动
      window.addEventListener('keydown', this.onMoveKeyDown)
      window.addEventListener('keyup', this.onMoveKeyUp)
      window.addEventListener('blur', this.onMoveBlur)
    } else {
      this.detachMoveKeys()
    }
    this.syncCursor()
    this.requestRender()
  }

  /** 摘掉键盘监听并清空按住的键（退出移动模式 / dispose）：只摘不清，镜头会自己一直走 */
  private detachMoveKeys(): void {
    window.removeEventListener('keydown', this.onMoveKeyDown)
    window.removeEventListener('keyup', this.onMoveKeyUp)
    window.removeEventListener('blur', this.onMoveBlur)
    this.moveKeys.clear()
    this.moveHeld = 0
  }

  private onMoveKeyDown = (event: KeyboardEvent): void => {
    // ⚠️ 带修饰键的一律不碰：Ctrl+W 关窗口、Cmd+Q 退应用 —— 抢过来就不止镜头在动
    if (event.ctrlKey || event.metaKey || event.altKey) return
    // 面板里还有输入框（重命名 / 搜索文件名）：在里面打字不该把镜头开走
    if (isTypingTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (!MOVE_KEYS.has(key)) return
    // 按住不放会一直重复 keydown：Set 天然去重，重复触发不该重启渲染循环
    if (this.moveKeys.has(key)) return
    this.moveKeys.add(key)
    this.requestRender()
  }

  private onMoveKeyUp = (event: KeyboardEvent): void => {
    // 松手无条件生效（不看事件来源，也不看面板焦点）：漏一次就是镜头一直走
    if (!this.moveKeys.delete(event.key.toLowerCase())) return
    // 键全松开了就重新起步（不靠下一帧清：标签隐藏时根本没有帧）
    if (this.moveKeys.size === 0) this.moveHeld = 0
    this.requestRender()
  }

  /** 窗口失焦（Alt+Tab 出去）收不到 keyup：不清掉按键就会一直往前走 */
  private onMoveBlur = (): void => {
    if (this.moveKeys.size === 0) return
    this.moveKeys.clear()
    this.moveHeld = 0
    this.requestRender()
  }

  /**
   * 走位：W/S 前后、A/D 左右（都在**水平面**上，竖直交给 Q/E）、Q/E 升降。
   *
   * ⚠️ 位移必须**相机与 `controls.target` 一起加**：`OrbitControls` 的模型是「绕 target 公转」，
   * 每帧 `update()` 都按 `position - target` 反解球坐标再重设相机位置 —— 只挪相机，下一帧就被拽回去。
   * 速度 = 主体最长边 / 2 每秒（`subjectLength`），**按住会一直加速**（每 1 秒加
   * `MOVE_ACCEL_PER_SECOND` 倍基础速度，没有「全速」这一档，松手重新起步）；
   * **例外：只按 A/D（左右平移）不加速** —— 横向是「微调对位」，越按越快就对不准。
   * 斜着走先归一化，否则对角线比直着走快 √2 倍。
   */
  private stepMove(delta: number): void {
    if (this.moveKeys.size === 0) {
      // 没按任何键：加速进度归零（标签隐藏时没有帧，靠这里兜底）
      this.moveHeld = 0
      return
    }
    const forward = this.controls.target.clone().sub(this.camera.position)
    // 抬头 / 低头时「前进」不该往地里钻：投到水平面，W 永远把人往前带
    forward.y = 0
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1)
    forward.normalize()
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize()
    const move = new THREE.Vector3()
    if (this.moveKeys.has('w')) move.add(forward)
    if (this.moveKeys.has('s')) move.sub(forward)
    if (this.moveKeys.has('d')) move.add(right)
    if (this.moveKeys.has('a')) move.sub(right)
    if (this.moveKeys.has('e')) move.y += 1
    if (this.moveKeys.has('q')) move.y -= 1
    if (move.lengthSq() < 1e-8) {
      // 相反的键互相抵消（w + s）：这一帧没走，加速进度也别攒着
      this.moveHeld = 0
      return
    }
    // 只有在「前后 / 升降」时才加速：只按 A/D 时**不加速也不攒进度**（横向平移是用来
    // 微调对位的，越按越快就对不准；而且不攒进度，松开 A/D 再按 W 也不会带着那段的加速度）
    const accelerating =
      this.moveKeys.has('w') ||
      this.moveKeys.has('s') ||
      this.moveKeys.has('e') ||
      this.moveKeys.has('q')
    if (accelerating) this.moveHeld += delta
    else this.moveHeld = 0
    // 一直加速：按得越久越快，没有「到顶」这一档
    const gain = 1 + this.moveHeld * MOVE_ACCEL_PER_SECOND
    move.normalize().multiplyScalar(this.moveSpeed() * gain * delta)
    // 别钻到地面以下：模型底面贴地，地下只有地板背面
    if (this.camera.position.y + move.y < MOVE_MIN_Y) move.y = MOVE_MIN_Y - this.camera.position.y
    this.camera.position.add(move)
    this.controls.target.add(move)
    this.requestRender()
  }

  /**
   * 走位速度（世界单位 / 秒）：**主体最长边的一半**。
   * 按模型自身尺寸推算而不是写死常量：「每秒走模型一半长」这个现感在任何比例下都成立。
   */
  private moveSpeed(): number {
    return Math.max(this.subjectLength / MOVE_SPEED_DIVISOR, MOVE_MIN_SPEED)
  }

  /**
   * 转视角：相机不动，把「相机 → 目标点」这根轴绕**相机**转（拖动改的是视线方向）。
   *
   * 不存 yaw / pitch：每次都从当前 `position → target` 现算，所以「重置视图 / 单独显示」的
   * 飞行结束后朝向天然还是对的，不用再同步一份平行状态。
   * 垂直那一步越界就整步回滚 —— 视线与世界上方向平行时再转会翻面。
   */
  private lookBy(dx: number, dy: number): void {
    const offset = this.controls.target.clone().sub(this.camera.position)
    const radius = offset.length()
    if (radius < 1e-6) return
    // 水平：绕世界 Y 轴（向右拖 = 向右看）
    offset.applyAxisAngle(WORLD_UP, -dx * MOVE_LOOK_SPEED)
    // 垂直：绕相机此刻的右向量（向下拖 = 向下看）
    const right = new THREE.Vector3().crossVectors(offset, WORLD_UP)
    if (right.lengthSq() > 1e-8) {
      const next = offset.clone().applyAxisAngle(right.normalize(), -dy * MOVE_LOOK_SPEED)
      // 旋转不改变长度：`next.y / radius` 就是新的极角余弦
      const phi = Math.acos(THREE.MathUtils.clamp(next.y / radius, -1, 1))
      if (phi > MOVE_PITCH_LIMIT && phi < Math.PI - MOVE_PITCH_LIMIT) offset.copy(next)
    }
    this.controls.target.copy(this.camera.position).add(offset)
    this.requestRender()
  }

  /** 画布点选的回调（面板给）：场景先挂好高亮，再把 id 通知面板 —— 两处状态只差这一次通知 */
  setMeshPickHandler(handler: ((id: string | null) => void) | null): void {
    this.pickHandler = handler
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerAt = { x: event.clientX, y: event.clientY }
    // 移动模式：左键按住拖动 = 转视角（轨道已被关掉，这一路自己接管）
    if (!this.moveMode || event.button !== 0) return
    this.looking = true
    this.lookAt = { x: event.clientX, y: event.clientY }
    // 捕获指针：拖出画布（拖到工具栏 / 面板外面）不该就断成「松手了」
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.syncCursor()
  }

  /** 移动模式的转头：算**增量**（上一次指针 → 这一次），不看绝对位置 */
  private onPointerMove = (event: PointerEvent): void => {
    const last = this.lookAt
    if (!this.looking || !last) return
    this.lookAt = { x: event.clientX, y: event.clientY }
    this.lookBy(event.clientX - last.x, event.clientY - last.y)
  }

  /**
   * 移动模式的滚轮：沿视线前后推拉（相当于「走近 / 退后」）。
   * 不给这条路的话，轨道一关它的滚轮缩放也一起失效 —— 想拉近只能一直按 W。
   * 视距夹在 `minDistance` / `maxDistance` 之间（与轨道同一套限制，切回去不会突然弹一下）。
   */
  private onMoveWheel = (event: WheelEvent): void => {
    if (!this.moveMode) return
    // 不让滚轮同时去滚面板 / 页面
    event.preventDefault()
    const offset = this.camera.position.clone().sub(this.controls.target)
    const radius = offset.length()
    if (radius < 1e-6) return
    // deltaMode：0 = 像素，1 = 行，2 = 页（Firefox 常给行，不换算的话一档滚轮几乎不动）
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
    const factor = Math.exp(THREE.MathUtils.clamp(event.deltaY * scale, -240, 240) * MOVE_WHEEL_ZOOM)
    const next = THREE.MathUtils.clamp(
      radius * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    )
    this.camera.position.copy(this.controls.target).add(offset.setLength(next))
    this.requestRender()
  }

  /**
   * 点选：只有在「选中模式」下、且这一下不是拖视角（位移 < `PICK_SLOP`）才算点击。
   * 命中最近的**可见**网格；点空白处 = 取消选中（把 id 交成 null，由面板反映到列表上）。
   */
  private onPointerUp = (event: PointerEvent): void => {
    // 先收尾转头手势：下面点选一支有一堆 early return，放后面就会漏掉「松手了」
    if (this.looking) {
      this.looking = false
      this.lookAt = null
      const canvas = this.renderer.domElement
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      this.syncCursor()
    }
    const start = this.pointerAt
    this.pointerAt = null
    if (!start || !this.options.selectionMode || !this.pickHandler) return
    if (
      Math.abs(event.clientX - start.x) > PICK_SLOP ||
      Math.abs(event.clientY - start.y) > PICK_SLOP
    ) {
      return
    }
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const targets: THREE.Object3D[] = []
    for (const object of this.meshObjects.values()) {
      if (isVisibleInTree(object)) targets.push(object)
    }
    this.raycaster.setFromCamera(pointer, this.camera)
    const hit = this.raycaster.intersectObjects(targets, false)[0] ?? null
    const hitId = hit ? (this.meshIds.get(hit.object) ?? null) : null
    // 再点一次已经选中的那一块 = 取消选中（与列表里连点两下同一口径）
    const id = hit && hitId && hit.object === this.selected ? null : hitId
    this.selectMesh(id)
    this.pickHandler(id)
  }

  setWireframe(on: boolean): void {
    this.options.wireframe = on
    this.applyMaterials()
    this.requestRender()
  }

  setGrid(on: boolean): void {
    this.options.showGrid = on
    this.grid.visible = on
    // 过渡中的旧网格也一起切：只管新的会留下一条「关不掉的旧线」
    if (this.gridFade) this.gridFade.old.visible = on
    this.requestRender()
  }

  setAxes(on: boolean): void {
    this.options.showAxes = on
    // 正轴与反向臂是两份对象：只切一半就是「关不掉」/「只亮一半」
    this.axes.visible = on
    this.axesNegative.visible = on
    this.requestRender()
  }

  setAutoRotate(on: boolean): void {
    this.options.autoRotate = on
    // 移动模式下自动旋转被临时关掉（见 `setMoveMode`）：开关状态记着，但先不给轨道
    this.controls.autoRotate = on && !this.moveMode
    this.controls.autoRotateSpeed = 1.5
    this.requestRender()
  }

  setModelLights(on: boolean): void {
    this.options.useModelLights = on
    this.applyModelLights()
    this.requestRender()
  }

  /**
   * 模型自带的 punctual 灯（glTF `KHR_lights_punctual`）：**默认关**。
   *
   * 为什么不能直接用：它们是按**作者自己的场景尺度**标的物理量（本例点光 220–2600 cd、
   * 方向光 12–120 lux），而预览会把整棵树缩到最长边 2.5（实测 ×0.005）——距离缩 200 倍，
   * 点光辐照度就大 4 万倍，方向光更是不衰减。石墙被 ACES 压成一整块白（实测整幅 90% 像素 ≥240）。
   *
   * 打开时按预览尺度归一，只保留相对明暗与色温：
   * - 点光 / 聚光：先乘 `scale²` 还原作者尺度下的辐照度，再按「主体中心」封顶到
   *   `MODEL_LIGHT_CAP`（与预览主光同量级）—— 贴着火盆的墙面仍会比远处亮；
   * - 方向光：按最亮那盏整体缩，保持它们之间的比例（否则三盏全被锁到上限，日/轮形光就没了）。
   */
  private applyModelLights(): void {
    const on = this.options.useModelLights
    if (this.model) this.model.updateMatrixWorld(true)

    // 方向光共用一个缩放系数，比例不丢
    let strongest = 0
    for (const item of this.modelLights) {
      if (!item.attenuates) strongest = Math.max(strongest, item.intensity)
    }
    const directionalGain = strongest > MODEL_LIGHT_CAP ? MODEL_LIGHT_CAP / strongest : 1

    const worldPosition = new THREE.Vector3()
    const scale = Math.max(this.fittedScale, 1e-6)
    for (const item of this.modelLights) {
      item.light.visible = on
      if (!on) {
        item.light.intensity = item.intensity
        continue
      }
      if (item.attenuates) {
        item.light.getWorldPosition(worldPosition)
        const distance = Math.max(worldPosition.distanceTo(this.subjectCenter), 1e-4)
        const ceiling = MODEL_LIGHT_CAP * distance * distance
        item.light.intensity = Math.min(item.intensity * scale * scale, ceiling)
      } else {
        item.light.intensity = item.intensity * directionalGain
      }
    }
  }

  /**
   * 应用场景预设：背景 / 地面 / 环境反射 / 三盏灯 / 曝光 / 网格配色。
   *
   * 颜色、灯位、曝光**插值过去**（`PRESET_FADE_MS`，缓入缓出）：六套主题之间切换原本是硬切，
   * 一帧之内从深色跳到灰白，眼睛会明显震一下。只有两样立刻生效：环境贴图（换的是整张
   * PMREM，没法插值）与网格配色（顶点色，新旧两份对淡）。
   * 起点取**当前实际值**而不是上一份预设：中途再切一次能从半路接着走，不会先跳回去。
   */
  applyPreset(preset: ModelPreset): void {
    this.applyEnvironment(preset)
    this.startGridFade(preset.grid.center, preset.grid.grid)
    this.lookFade = { from: this.currentLook(), to: lookOf(preset), elapsed: 0 }
    this.requestRender()
  }

  /** 当前实际观感：读场景里的活对象，不读预设表（过渡中途读到的才是半路状态） */
  private currentLook(): SceneLook {
    const background = this.scene.background
    return {
      background: (background instanceof THREE.Color
        ? background
        : new THREE.Color('#0e1116')
      ).clone(),
      ground: this.groundMaterial.color.clone(),
      hemiSky: this.hemi.color.clone(),
      hemiGround: this.hemi.groundColor.clone(),
      hemiIntensity: this.hemi.intensity,
      sunColor: this.sun.color.clone(),
      sunIntensity: this.sun.intensity,
      sunPosition: this.sun.position.clone(),
      fillColor: this.fill.color.clone(),
      fillIntensity: this.fill.intensity,
      fillPosition: this.fill.position.clone(),
      exposure: this.renderer.toneMappingExposure,
    }
  }

  private applyLook(look: SceneLook): void {
    // 背景色是场景自带的那个 Color：就地改，别每帧换一个新对象
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(look.background)
    else this.scene.background = look.background.clone()
    this.groundMaterial.color.copy(look.ground)
    this.hemi.color.copy(look.hemiSky)
    this.hemi.groundColor.copy(look.hemiGround)
    this.hemi.intensity = look.hemiIntensity
    this.sun.color.copy(look.sunColor)
    this.sun.intensity = look.sunIntensity
    this.sun.position.copy(look.sunPosition)
    this.fill.color.copy(look.fillColor)
    this.fill.intensity = look.fillIntensity
    this.fill.position.copy(look.fillPosition)
    this.renderer.toneMappingExposure = look.exposure
  }

  /** 推进一帧场景过渡：到头就落到目标的精确值（插值尾段永远差一丁点） */
  private stepLookFade(delta: number): void {
    const fade = this.lookFade
    if (!fade) return
    fade.elapsed += delta * 1000
    const raw = Math.min(1, fade.elapsed / PRESET_FADE_MS)
    this.applyLook(raw >= 1 ? fade.to : lerpLook(fade.from, fade.to, easeInOutCubic(raw)))
    if (raw >= 1) this.lookFade = null
  }

  /**
   * 环境反射来源：默认是 64×32 的**竖直渐变**（只能表达上天下地的色温）；
   * `env: 'room'` 换成 three 自带的摄影棚（RoomEnvironment）—— 柔光箱有形状，
   * 金属 / 低粗糙材质才有可判的反射。摄影棚贴图懒建一次后缓存，来回切预设不必重建（PMREM 要渲一遍）。
   */
  private applyEnvironment(preset: ModelPreset): void {
    if (preset.env === 'room') {
      if (!this.roomTexture) {
        const room = new RoomEnvironment()
        this.roomTexture = this.pmrem.fromScene(room, 0.04).texture
        room.dispose()
      }
      this.useEnvironment(this.roomTexture)
      return
    }

    const gradient = makeGradientTexture(preset.envTop, preset.envBottom)
    const target = this.pmrem.fromEquirectangular(gradient)
    gradient.dispose()
    // ⚠️ 兜底：CubeUV 高度小于 2 时，three 会把 `CUBEUV_TEXEL_HEIGHT` 定义成整数字面量
    // （`1.0 / 1` → `1`），片元着色器里 `uv.y *= CUBEUV_TEXEL_HEIGHT` 编译失败 ——
    // 带 envMap 的材质全都画不出，表现是「模型一片空白」（已踩过：源贴图宽度给成 1 时
    // PMREM 用 `width / 4` 算 cube 尺寸，整个贴图塔成 1px）。宁可退回上一个环境贴图。
    if (target.height >= 2) {
      this.useEnvironment(target.texture)
    } else {
      target.dispose()
    }
  }

  /** 换环境贴图：渐变那张是每次新建的（要放掉），缓存的摄影棚贴图不能放 */
  private useEnvironment(texture: THREE.Texture): void {
    if (this.envTexture !== texture && this.envTexture !== this.roomTexture) {
      this.envTexture?.dispose()
    }
    this.envTexture = texture
    this.scene.environment = texture
  }

  // ------------------------------------------------------------------ 动画

  /** 播放下标对应的片段；`index < 0` = 全部停下 */
  playAnimation(index: number): void {
    this.stopAnimations()
    if (!this.mixer || index < 0 || index >= this.clips.length) return
    const action = this.mixer.clipAction(this.clips[index])
    action.reset()
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.clampWhenFinished = false
    action.play()
    this.currentAction = action
    this.requestRender()
  }

  stopAnimations(): void {
    this.currentAction?.stop()
    this.currentAction = null
    this.mixer?.stopAllAction()
    this.requestRender()
  }

  // ------------------------------------------------------------------ 输出

  /** 当前画面转 PNG dataURL；容器没有尺寸（隐藏标签）时返回 null（会是一张空图） */
  screenshot(): string | null {
    if (this.disposed || !this.hasSize()) return null
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  // ------------------------------------------------------------------ 内部

  private hasSize(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0
  }

  private setGridOpacity(grid: THREE.GridHelper): void {
    const material = grid.material as THREE.Material
    material.transparent = true
    material.opacity = GRID_OPACITY
  }

  /**
   * 网格配色换档：`GridHelper` 的颜色烘在顶点色里，改色只能整份重建 ——
   * 但直接换会「啪」一下变灰，所以让新旧两份对淡（同尺寸同分度，线完全重合，看不出来是两份）。
   */
  private startGridFade(center: string, gridColor: string): void {
    // 上一轮没淡完又换档：旧的直接扔掉（它已经在淡出途中，留着也只是一条较亮的旧线）
    if (this.gridFade) this.disposeGrid(this.gridFade.old)
    const next = new THREE.GridHelper(
      GRID_SIZE,
      GRID_DIVISIONS,
      new THREE.Color(center),
      new THREE.Color(gridColor),
    )
    this.setGridOpacity(next)
    ;(next.material as THREE.Material).opacity = 0
    next.visible = this.options.showGrid
    this.scene.add(next)
    this.gridFade = { old: this.grid, elapsed: 0 }
    this.grid = next
  }

  private stepGridFade(delta: number): void {
    const fade = this.gridFade
    if (!fade) return
    fade.elapsed += delta * 1000
    const raw = Math.min(1, fade.elapsed / PRESET_FADE_MS)
    ;(this.grid.material as THREE.Material).opacity = GRID_OPACITY * raw
    ;(fade.old.material as THREE.Material).opacity = GRID_OPACITY * (1 - raw)
    if (raw >= 1) {
      this.disposeGrid(fade.old)
      this.gridFade = null
    }
  }

  private disposeGrid(grid: THREE.GridHelper): void {
    this.scene.remove(grid)
    grid.geometry.dispose()
    ;(grid.material as THREE.Material).dispose()
  }

  /**
   * 材质替身：线框 / 非选中半透明**共用这一条通路**。
   *
   * 为什么不各自写一套：两者都会改 `object.material`，分开写就会把对方的替身盖掉，
   * 而且换回去时拿到的是对面的替身 —— 原件（连同贴图）从此没人释放。所以每次状态变化
   * 整批重建：从 WeakMap 里的原件出发 → 需要的替身，旧的替身一次性放掉。
   */
  private applyMaterials(): void {
    this.releaseOverrides()
    // 选中的那个被藏起来了：半透明也就没必要了（否则满屏灰而没有任何高亮）
    if (this.selected && !isVisibleInTree(this.selected)) this.selected = null
    const selected = this.selected
    this.model?.traverse((child) => {
      const drawable = child as DrawableLike
      const original = this.originalMaterials.get(child)
      if (!original) return
      const wireframe = this.options.wireframe && !!drawable.isMesh
      // 藏起来的不参与渲染，不必再给它造替身
      const dimmed = selected !== null && child !== selected && isVisibleInTree(child)
      if (!wireframe && !dimmed) {
        drawable.material = original
        return
      }
      const list = Array.isArray(original) ? original : [original]
      const clones = list.map((material) => {
        const clone = material.clone()
        // 线框只有带三角面的材质有这个开关（点云 / 线的材质没有，`in` 处守一下）
        if (wireframe && 'wireframe' in clone) {
          ;(clone as THREE.MeshStandardMaterial).wireframe = true
        }
        if (dimmed) {
          clone.transparent = true
          clone.opacity = Math.min(clone.opacity, DIM_OPACITY)
          // 不关深度写入的话，十几个透明网格会互相挡成一团（先画的把后面的挖掉）
          clone.depthWrite = false
        }
        this.materialOverrides.push(clone)
        return clone
      })
      drawable.material = Array.isArray(original) ? clones : clones[0]
    })
    this.requestRender()
  }

  /** 把原件装回去并放掉所有替身（换模型 / dispose 前必须做：否则原件永远没人释放） */
  private restoreMaterials(): void {
    this.model?.traverse((child) => {
      const drawable = child as DrawableLike
      const original = this.originalMaterials.get(child)
      if (original) drawable.material = original
    })
    this.releaseOverrides()
  }

  private releaseOverrides(): void {
    for (const material of this.materialOverrides) material.dispose()
    this.materialOverrides = []
  }

  /** 标记需要渲染，并在循环停着时重新启动 */
  requestRender(): void {
    if (this.rafId === 0 && !this.disposed) {
      this.rafId = requestAnimationFrame(this.animate)
    }
  }

  private animate = (): void => {
    if (this.disposed) return
    // clamp delta：循环停过之后恢复时不要一次跳很远（动画会瞬移）
    this.timer.update()
    const delta = Math.min(this.timer.getDelta(), 0.1)
    const cameraPosition = this.camera.position.clone()
    const cameraTarget = this.controls.target.clone()
    // 飞行先落位、再让 `controls.update()` 归一（夹距离 / 阻尼）—— 顺序反了会被它按上一帧的球坐标盖回去
    if (this.flight) this.stepFlight(delta)
    // 移动模式的走位：飞行期间不接管（落点是飞行算的，插一脚就打架）
    else if (this.moveMode) this.stepMove(delta)
    // 场景过渡（背景 / 灯光 / 曝光 / 网格配色）也按 delta 推进
    if (this.lookFade) this.stepLookFade(delta)
    if (this.gridFade) this.stepGridFade(delta)
    this.controls.update()
    this.mixer?.update(delta)
    // 动画 / 拖视角期间模型在动：高亮框跟着走（静止时没有帧，`selectMesh` 那次已经更新过）
    this.highlight?.update()
    const moved =
      cameraPosition.distanceTo(this.camera.position) > 1e-6 ||
      cameraTarget.distanceTo(this.controls.target) > 1e-6

    // 隐藏标签 / 0 尺寸：停下等下一次 requestRender（口径 2）
    if (!this.hasSize()) {
      this.rafId = 0
      return
    }
    this.renderer.render(this.scene, this.camera)

    // 飞行 / 场景过渡没结束也必须继续出帧，否则动画只走一帧就停下
    if (
      this.currentAction ||
      // 移动模式下自动旋转已被关掉：还按 `options.autoRotate` 出帧就是白烧一个核
      (this.options.autoRotate && !this.moveMode) ||
      this.interacting ||
      this.flight ||
      this.lookFade ||
      this.gridFade ||
      moved
    ) {
      this.rafId = requestAnimationFrame(this.animate)
    } else {
      this.rafId = 0
    }
  }

  private resize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    // 0 尺寸（隐藏标签）：不改投影矩阵，等真正显示时的下一次回调
    if (width === 0 || height === 0) return
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height, false)
    this.requestRender()
  }

  /**
   * 释放一棵模型树：几何、材质，以及**材质上的贴图**。
   *
   * ⚠️ `Material.dispose()` 只管程序与事件，**不碰贴图**：不显式 `texture.dispose()`，
   * 那些 GL 纹理要等整个上下文丢失才回收 —— 开几个带 4K 贴图的模型就能把显存吃干净。
   * 同一张贴图常被多个材质共享：用 Set 去重，只放一次。
   */
  private disposeObject(object: THREE.Object3D): void {
    const textures = new Set<THREE.Texture>()
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        if (!material) continue
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          const texture = value as THREE.Texture | null
          if (texture && texture.isTexture) textures.add(texture)
        }
        material.dispose()
      }
    })
    for (const texture of textures) texture.dispose()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.resizeObserver.disconnect()
    this.timer.dispose()
    this.clearModel()
    this.controls.dispose()
    this.pmrem.dispose()
    if (this.envTexture && this.envTexture !== this.roomTexture) this.envTexture.dispose()
    this.envTexture = null
    this.roomTexture?.dispose()
    this.roomTexture = null

    this.ground.geometry.dispose()
    this.groundMaterial.dispose()
    // 过渡中的旧网格也是场景里的对象：不放掉就漏一份几何 + 材质
    if (this.gridFade) this.disposeGrid(this.gridFade.old)
    this.gridFade = null
    this.lookFade = null
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
    this.axes.dispose()
    this.axesNegative.dispose()

    this.renderer.dispose()
    // 键盘监听挂在 window 上：dispose 之后不清掉，按键还在往一个死场景里写
    this.detachMoveKeys()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('wheel', this.onMoveWheel)
    if (canvas.parentElement === this.container) this.container.removeChild(canvas)
  }
}

/**
 * 竖直渐变 equirect 纹理（上 = 天，下 = 地）→ 给 PMREM 当环境反射。
 * 只有 64×32 像素：环境反射要的是「上下世界的色温」，不需要细节。
 *
 * ⚠️ **宽度不能小**：`PMREMGenerator._fromTexture` 对等距柱状贴图取
 * `texture.image.width / 4` 作为 cube 尺寸 —— 宽度 1 时 cube 尺寸 0.25，生成的 CubeUV
 * 高度塌成 1px，`CUBEUV_TEXEL_HEIGHT` 就成了整数字面量，片元着色器直接编译失败（模型不可见）。
 * 宽 ≥ 4 才正常，这里取 64（2:1，也是等距柱状贴图的常规比例）。
 */
function makeGradientTexture(top: string, bottom: string): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 32
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, 32)
    gradient.addColorStop(0, top)
    gradient.addColorStop(1, bottom)
    context.fillStyle = gradient
    context.fillRect(0, 0, 64, 32)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
