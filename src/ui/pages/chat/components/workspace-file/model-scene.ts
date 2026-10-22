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
 * 4. **必须 dispose**：几何 / 材质 / 纹理 / 环境贴图 / renderer 全放掉。标签关掉即卸载，
 *    一个 5MB 的 glb 开关几次就能把显存吃干净。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { ModelPreset } from './model-presets'

/** 预览的可视化选项（工具栏那几个开关） */
export interface ModelViewOptions {
  wireframe: boolean
  showGrid: boolean
  showAxes: boolean
  autoRotate: boolean
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

export class ModelScene {
  private readonly container: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private grid: THREE.GridHelper
  private readonly axes: THREE.AxesHelper
  private readonly hemi: THREE.HemisphereLight
  private readonly sun: THREE.DirectionalLight
  private readonly fill: THREE.DirectionalLight
  private readonly ground: THREE.Mesh
  private readonly groundMaterial: THREE.MeshStandardMaterial
  private readonly pmrem: THREE.PMREMGenerator
  private envTexture: THREE.Texture | null = null
  private readonly resizeObserver: ResizeObserver

  private model: THREE.Object3D | null = null
  /** 模型根节点进来时的原始变换：取景 / 重置都从它算起（口径 3） */
  private homeTransform: {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  } | null = null
  /** 模型自身单位下的包围盒尺寸（自动取景前记下来，`getStats` 报的才是真实尺寸） */
  private sourceSize: THREE.Vector3 | null = null
  /** 原始材质（线框开关来回切时还原用） */
  private readonly originalMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>()
  /** 线框替身材质：切回实心时要 dispose，否则每切一次就多留一份 */
  private wireClones: THREE.Material[] = []

  private mixer: THREE.AnimationMixer | null = null
  private clips: THREE.AnimationClip[] = []
  private currentAction: THREE.AnimationAction | null = null

  private readonly timer = new THREE.Timer()
  private rafId = 0
  private disposed = false
  /** 用户正按着鼠标拖轨道：拖拽期间保持渲染（阻尼衰减要靠连续帧） */
  private interacting = false

  readonly options: ModelViewOptions = {
    wireframe: false,
    showGrid: true,
    showAxes: true,
    autoRotate: false,
  }

  /** 「重置视图」回到的相机姿态（每次取景后更新） */
  private readonly homeCamera = {
    position: new THREE.Vector3(4, 2.5, 6),
    target: new THREE.Vector3(0, 1, 0),
  }

  constructor(container: HTMLElement) {
    this.container = container
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

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#0e1116')

    // 环境反射（IBL）：PBR 材质没有它就是一片死灰，比任何一盏灯都重要
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.envTexture = this.pmrem.fromScene(room, 0.04).texture
    this.scene.environment = this.envTexture
    room.dispose()

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 5000)
    this.camera.position.copy(this.homeCamera.position)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    // 贴地观察时相机钻到地面以下是常见的困惑来源：留一点下限
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.minDistance = 0.2
    this.controls.maxDistance = 200
    this.controls.target.copy(this.homeCamera.target)
    this.controls.addEventListener('start', () => {
      this.interacting = true
      this.requestRender()
    })
    this.controls.addEventListener('end', () => {
      this.interacting = false
      this.requestRender()
    })
    this.controls.addEventListener('change', () => this.requestRender())

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

    this.grid = new THREE.GridHelper(20, 40, 0x3a4250, 0x232833)
    this.setGridOpacity(this.grid)
    this.scene.add(this.grid)

    this.axes = new THREE.AxesHelper(1.2)
    this.scene.add(this.axes)

    // 接收阴影的地面：模型「站在地上」而不是飘着，全靠它
    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x15181d,
      roughness: 0.94,
      metalness: 0,
    })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.groundMaterial)
    this.ground.rotation.x = -Math.PI / 2
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

  /** 换模型：会先把上一份彻底释放（几何 / 材质 / 线框替身） */
  setModel(object: THREE.Object3D, animations: readonly THREE.AnimationClip[]): void {
    this.clearModel()
    this.model = object
    this.homeTransform = {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    }
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      if (mesh.material) this.originalMaterials.set(mesh, mesh.material)
      if (!mesh.name) mesh.name = 'mesh'
    })
    this.scene.add(object)
    this.clips = [...animations]
    this.mixer = animations.length > 0 ? new THREE.AnimationMixer(object) : null
    this.applyWireframe(this.options.wireframe)
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
    if (!this.model) return
    this.disposeObject(this.model)
    this.scene.remove(this.model)
    this.model = null
    this.releaseWireClones()
  }

  getClips(): THREE.AnimationClip[] {
    return this.clips
  }

  /**
   * 自动取景：模型居中、最长边缩到 `FIT_SIZE`、底部贴地，相机退到能装下它的距离。
   * 先恢复根节点原始变换再算 —— 反复「重置视图」不会把模型越缩越小（口径 3）。
   */
  frameObject(): void {
    const object = this.model
    if (!object) {
      this.camera.position.copy(this.homeCamera.position)
      this.controls.target.copy(this.homeCamera.target)
      this.controls.update()
      return
    }
    if (this.homeTransform) {
      object.position.copy(this.homeTransform.position)
      object.quaternion.copy(this.homeTransform.quaternion)
      object.scale.copy(this.homeTransform.scale)
    }
    object.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    // 原始尺寸在缩放前记下来：面板里显示的「尺寸」要是模型自己的单位
    this.sourceSize = size.clone()

    const maxDimension = Math.max(size.x, size.y, size.z, 1e-6)
    const scale = FIT_SIZE / maxDimension
    object.scale.multiplyScalar(scale)
    // 横向居中、底部贴地（y = 0 是地面）
    object.position.x += -center.x * scale
    object.position.y += -box.min.y * scale
    object.position.z += -center.z * scale

    const fitted = new THREE.Box3().setFromObject(object)
    const fittedSize = fitted.getSize(new THREE.Vector3())
    const fittedCenter = fitted.getCenter(new THREE.Vector3())
    const fov = (this.camera.fov * Math.PI) / 180
    const distance =
      (Math.max(fittedSize.x, fittedSize.y, fittedSize.z) / (2 * Math.tan(fov / 2))) * 1.9
    const direction = new THREE.Vector3(1, 0.55, 1).normalize()
    this.camera.position.copy(fittedCenter).add(direction.multiplyScalar(distance))
    this.controls.target.copy(fittedCenter)
    this.controls.update()

    this.homeCamera.position.copy(this.camera.position)
    this.homeCamera.target.copy(fittedCenter)
    this.requestRender()
  }

  resetView(): void {
    this.frameObject()
  }

  getStats(): ModelStats | null {
    if (!this.model) return null
    let triangles = 0
    let vertices = 0
    let meshes = 0
    const materials = new Set<THREE.Material>()
    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      meshes += 1
      const geometry = mesh.geometry
      if (geometry) {
        // 索引几何：一个三角形 = 3 个索引；非索引几何：一个三角形 = 3 个顶点
        if (geometry.index) triangles += geometry.index.count / 3
        else if (geometry.attributes.position) triangles += geometry.attributes.position.count / 3
        if (geometry.attributes.position) vertices += geometry.attributes.position.count
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
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

  // ------------------------------------------------------------------ 选项

  setWireframe(on: boolean): void {
    this.options.wireframe = on
    this.applyWireframe(on)
    this.requestRender()
  }

  setGrid(on: boolean): void {
    this.options.showGrid = on
    this.grid.visible = on
    this.requestRender()
  }

  setAxes(on: boolean): void {
    this.options.showAxes = on
    this.axes.visible = on
    this.requestRender()
  }

  setAutoRotate(on: boolean): void {
    this.options.autoRotate = on
    this.controls.autoRotate = on
    this.controls.autoRotateSpeed = 1.5
    this.requestRender()
  }

  /** 应用场景预设：背景 / 地面 / 环境反射 / 三盏灯 / 曝光 / 网格配色 */
  applyPreset(preset: ModelPreset): void {
    this.scene.background = new THREE.Color(preset.background)
    this.groundMaterial.color.set(preset.ground)

    const gradient = makeGradientTexture(preset.envTop, preset.envBottom)
    const target = this.pmrem.fromEquirectangular(gradient)
    gradient.dispose()
    // ⚠️ 兑底：CubeUV 高度小于 2 时，three 会把 `CUBEUV_TEXEL_HEIGHT` 定义成整数字面量
    // （`1.0 / 1` → `1`），片元着色器里 `uv.y *= CUBEUV_TEXEL_HEIGHT` 编译失败 ——
    // 带 envMap 的材质全都画不出，表现是「模型一片空白」（已踩过：源贴图宽度给成 1 时
    // PMREM 用 `width / 4` 算 cube 尺寸，整个贴图塔成 1px）。宁可退回上一个环境贴图。
    if (target.height >= 2) {
      this.envTexture?.dispose()
      this.envTexture = target.texture
      this.scene.environment = this.envTexture
    } else {
      target.dispose()
    }

    this.hemi.color.set(preset.hemi.sky)
    this.hemi.groundColor.set(preset.hemi.ground)
    this.hemi.intensity = preset.hemi.intensity

    this.sun.color.set(preset.sun.color)
    this.sun.intensity = preset.sun.intensity
    this.sun.position.set(...preset.sun.position)

    this.fill.color.set(preset.fill.color)
    this.fill.intensity = preset.fill.intensity
    this.fill.position.set(...preset.fill.position)

    this.renderer.toneMappingExposure = preset.exposure
    this.rebuildGrid(preset.grid.center, preset.grid.grid)
    this.requestRender()
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
    material.opacity = 0.6
  }

  /** GridHelper 的颜色烘在顶点色里：换配色只能重建 */
  private rebuildGrid(center: string, gridColor: string): void {
    this.scene.remove(this.grid)
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
    this.grid = new THREE.GridHelper(
      20,
      40,
      new THREE.Color(center),
      new THREE.Color(gridColor),
    )
    this.setGridOpacity(this.grid)
    this.grid.visible = this.options.showGrid
    this.scene.add(this.grid)
  }

  /**
   * 线框：克隆一份材质改 `wireframe`，原始材质留在 WeakMap 里等着还原。
   * 不能直接改原材质 —— glTF 常常多个 mesh 共享同一个材质，改一个会连带改一片。
   */
  private applyWireframe(on: boolean): void {
    if (!this.model) return
    this.releaseWireClones()
    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const original = this.originalMaterials.get(mesh)
      if (!original) return
      if (!on) {
        mesh.material = original
        return
      }
      const list = Array.isArray(original) ? original : [original]
      const clones = list.map((material) => {
        const clone = material.clone() as THREE.MeshStandardMaterial
        clone.wireframe = true
        this.wireClones.push(clone)
        return clone
      })
      mesh.material = Array.isArray(original) ? clones : clones[0]
    })
  }

  private releaseWireClones(): void {
    for (const material of this.wireClones) material.dispose()
    this.wireClones = []
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
    this.controls.update()
    this.mixer?.update(delta)
    const moved =
      cameraPosition.distanceTo(this.camera.position) > 1e-6 ||
      cameraTarget.distanceTo(this.controls.target) > 1e-6

    // 隐藏标签 / 0 尺寸：停下等下一次 requestRender（口径 2）
    if (!this.hasSize()) {
      this.rafId = 0
      return
    }
    this.renderer.render(this.scene, this.camera)

    if (this.currentAction || this.options.autoRotate || this.interacting || moved) {
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

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) material?.dispose()
    })
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
    this.envTexture?.dispose()
    this.envTexture = null

    this.ground.geometry.dispose()
    this.groundMaterial.dispose()
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
    this.axes.dispose()

    this.renderer.dispose()
    const canvas = this.renderer.domElement
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
