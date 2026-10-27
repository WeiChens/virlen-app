/**
 * 3D 模型的加载器注册表：**扩展名 → three 的 loader**（面板只把字节交给这一层）。
 *
 * 九条口径：
 * 1. **扩展名的唯一源是 `domain/files/preview.ts`**（`ModelExtension` / `MODEL_EXTENSIONS`）。
 *    下面那张 `Record<ModelExtension, …>` 是穷尽检查：那边加了格式却忘了加加载器，编译期就报错
 *    （铁律 3：双份镜像必须同步，这里用类型系统钉住）。
 * 2. **每种格式各自动态 `import()`**：所有 loader 加起来比应用主包还大，只有真的打开模型才下载
 *    对应的那几个（PDF 预览的 pdfjs 是同一手法，见 `pdf-view.tsx`）。
 * 3. **只处理单文件模型**：面板只拿到**一个文件**的字节，所以 `.gltf` 引用外部 `.bin` / 贴图时
 *    在解析前就拦下并给一句人话（否则 GLTFLoader 抛的是 `Failed to load buffer`）。
 * 4. **纯几何格式补默认材质**：STL / PLY 只有顶点、OBJ 常常没有 mtl，不补就是一片全黑。
 * 5. **贴图先按磁盘找，找不到才静默**：FBX / 3DS / DAE 里写的是**相对路径**，而 loader 是相对
 *    页面基址去取的（`FBXLoader` 更狠，直接把目录剥掉只留文件名）—— 一个都取不到。面板拿得到
 *    模型的绝对路径，所以在 `parse` 之前由 `model-textures.ts` 把同目录的贴图读成 blob URL，
 *    再经 `LoadingManager.setURLModifier` 换进去（`tga` / `dds` 另注册 three 的专用 loader）。
 *    仍然找不到的：`LoadingManager.onError` 直接吞掉 —— 否则控制台刷一片 404，而模型其实已经画出来了。
 * 6. **glTF 的金属度缺省值不是 0**：`metallicFactor` 不写 = 纯金属（亮度只剩环境反射），
 *    加载后统一过一遍 `fixUndeclaredMetalness`。
 * 7. **非 PBR 材质一律换成 `MeshStandardMaterial`**：Phong / Lambert 在 three 里**没有**
 *    `RE_IndirectSpecular`（`lights_phong_pars_fragment` 只定义了 Direct 与 IndirectDiffuse），
 *    所以只拿得到环境光的漫反射、拿不到 IBL 高光；同一份资产换成 GLB 走 Standard 就明显更亮。
 *    预览要的是「同一模型不同格式观感一致」，不是还原各家的着色模型（FBX / DAE / 3DS / WRL /
 *    OBJ / 3MF / AMF 都走这一遍）。颜色贴图（`map` / `emissiveMap`）顺手补上 `SRGBColorSpace`：
 *    FBX / WRL 的 loader 自己会标，DAE / 3DS / 3MF 不会 —— 不补就会整体发白。
 *    ⚠️ Blender 导出的 FBX 把**线性**颜色直接写进 `Diffuse` / `Emissive`（实测与 glTF 的
 *    `baseColorFactor` 逐位相等），而 `FBXLoader` 一律当 sRGB 解 —— 双重解码、整体暗一档；
 *    它的 `ShininessExponent` 也是 `100·(1-roughness)²`。两样都按导出器反算回去
 *    （`detectBlenderFbx` / `blenderShininessToRoughness`），实测 racecar 一对文件完全对得上。
 * 8. **贴图是异步到的、而且可能根本到不了**：`parse` 返回时每个 `TextureLoader` 的纹理都还没有
 *    `image`，得等这一批结束再判定；从没上传成功的槽（`Texture.version` 恒为 0）会把材质乘成黑的，
 *    必须摘掉，同时让场景补画一帧（静止的预览不会自己重绘）。
 * 9. **blob URL 的生命周期跟着模型走**：本地贴图造出来的 URL 由 `LoadedModel.dispose()` 一起放，
 *    面板在换文件 / 卸载时调它 —— 否则每开一个模型就漏一份贴图字节的内存。
 * 10. **不靠控制台说话**：贴图缺失 / 过大 / 失效槽被移除这些「模型还能看，但不对劲」的情况
 *    全部通过 `ctx.report` 进面板的异常日志（`model-diagnostics.ts`）；报得上去才有得看，
 *    不该让用户去开 DevTools 才明白为什么是纯色。
 */
import type * as THREE from 'three'
import { extensionOf, type ModelExtension } from '@/domain/files/preview'
import { loadModelTextures, type ModelTextures } from './model-textures'
import {
  DIAGNOSTIC_TITLES,
  droppedTextureDiagnostic,
  textureDiagnostic,
  type DiagnosticReport,
} from './model-diagnostics'

/** 加载完成的一个模型 */
export interface LoadedModel {
  object: THREE.Object3D
  /** 动画片段（没有动画的格式为空数组） */
  animations: THREE.AnimationClip[]
  /** 小写扩展名 */
  format: ModelExtension
  /** 本地贴图统计（`found < total` = 有贴图没在磁盘上找到）；没有外部引用时为空 */
  textures?: { found: number; total: number }
  /** 放掉解析期间新增的资源（目前只有本地贴图的 blob URL，口径 9），可重复调用 */
  dispose?: () => void
}

export interface ModelLoadContext {
  /**
   * KTX2 贴图要知道当前 renderer 支持哪种压缩格式（`detectSupport`）；
   * 没有 renderer 就只是解不出 KTX2 贴图，几何与其余贴图照常。
   */
  renderer?: THREE.WebGLRenderer
  /** 异步贴图到齐后叫一声：场景要补画一帧，否则贴图要等用户拖一下才出现（口径 8） */
  onLateChange?: () => void
  /**
   * 模型在磁盘上的**绝对路径**：给了才会去同目录找它引用的贴图（口径 5）。
   * 面板拿得到（`LoadedModelFile.path`）；只有字节的调用方（用例）可以不给。
   */
  path?: string
  /**
   * 异常上报（见 `model-diagnostics.ts`）：贴图缺失 / 贴图过大 / 失效贴图槽被移除…
   * 面板把它接进工具栏的「异常日志」（不给就只存 silently，与旧行为一致）。
   */
  report?: DiagnosticReport
}

/** 可本地化的失败原因（其余异常按库的原文显示在详情里） */
export type ModelLoadErrorCode = 'external-resources' | 'unsupported'

export class ModelLoadError extends Error {
  constructor(
    readonly code: ModelLoadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ModelLoadError'
  }
}

type ThreeModule = typeof import('three')

async function loadThree(): Promise<ThreeModule> {
  return await import('three')
}

/**
 * three 的 loader 吃 `ArrayBuffer`，而从 plugin-fs 拿到的是 `Uint8Array`：
 * 底层 buffer 可能是 SharedArrayBuffer 或带偏移，拷一份干净的再交出去。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function toText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** 外部贴图读不到是常态（面板只有一个文件）：不刷控制台，模型照画 */
async function quietManager(): Promise<THREE.LoadingManager> {
  const THREE = await loadThree()
  const manager = new THREE.LoadingManager()
  manager.onError = () => {}
  return manager
}

/** 材质上的贴图槽：换材质时照抄、清理失效时逐个查 */
export const TEXTURE_SLOTS = [
  'map',
  'alphaMap',
  'aoMap',
  'lightMap',
  'emissiveMap',
  'normalMap',
  'bumpMap',
  'displacementMap',
  'specularMap',
  'envMap',
] as const

export interface TextureLike {
  image?: unknown
  version?: number
}

export interface ObjectTree {
  traverse(callback: (child: unknown) => void): void
}

interface MeshLike {
  isMesh?: boolean
  material?: unknown
}

/**
 * 贴图「上传过」才算可用。
 *
 * ⚠️ `WebGLTextures.setTexture2D` 只在 `texture.version > 0` 时才 `uploadTexture`；
 * 加载失败 / `new Texture()` 占位件永远是 0 —— 采样到未定义内容，`map` 会把材质乘成黑的。
 */
export function isTextureUsable(texture: TextureLike | null | undefined): boolean {
  return !!texture && !!texture.image && (texture.version ?? 0) > 0
}

/**
 * 摘掉从没加载成功的贴图槽，返回摘掉的个数（0 = 没动过，调用方据此判断要不要补画）。
 *
 * 只摘「确定坏」的：有 image 且上传过的贴图一个字不动。
 */
export function dropUnloadedTextures(object: ObjectTree): number {
  let dropped = 0
  const seen = new Set<object>()
  object.traverse((child) => {
    const mesh = child as MeshLike
    if (!mesh?.isMesh || !mesh.material) return
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of list) {
      if (!material || typeof material !== 'object' || seen.has(material)) continue
      seen.add(material)
      const record = material as Record<string, unknown>
      let removed = 0
      for (const slot of TEXTURE_SLOTS) {
        const texture = record[slot] as TextureLike | null | undefined
        if (!texture || isTextureUsable(texture)) continue
        record[slot] = null
        removed += 1
      }
      // 摘掉一个槽会换着色器程序（USE_MAP 等宏变了），必须重编译
      if (removed > 0) {
        dropped += removed
        if ('needsUpdate' in record) record.needsUpdate = true
      }
    }
  })
  return dropped
}

/**
 * 等这批贴图**全部结束**（成功或失败）再清理失效槽 + 通知补画。
 * 返回的函数在拿到模型对象后调用一次：那时若一个加载项都没有（模型根本不带贴图），立刻收尾。
 */
function watchTextures(
  manager: THREE.LoadingManager,
  onSettled: ((dropped: number) => void) | undefined,
): (object: THREE.Object3D) => void {
  let object: THREE.Object3D | null = null
  let pending = 0
  const itemStart = manager.itemStart.bind(manager)
  const itemEnd = manager.itemEnd.bind(manager)
  const settle = () => {
    if (!object) return
    onSettled?.(dropUnloadedTextures(object))
  }
  manager.itemStart = (url) => {
    pending += 1
    itemStart(url)
  }
  manager.itemEnd = (url) => {
    itemEnd(url)
    pending -= 1
    if (pending === 0) settle()
  }
  return (model) => {
    object = model
    if (pending === 0) settle()
  }
}

/**
 * 一批贴图结算：把「失效槽被摘掉」记进异常日志，再让场景补画一帧（口径 8）。
 *
 * 两个都要做：少了前者用户只看到「莫名其妙变回纯色」，少了后者贴图要等拖一下才出现。
 */
function settleTextures(ctx: ParseContext, dropped: number): void {
  const issue = droppedTextureDiagnostic(dropped)
  if (issue) ctx.report?.(issue)
  ctx.onLateChange?.()
}

/**
 * 把本地贴图接到 `LoadingManager` 上（口径 5），两件事：
 * 1. `setURLModifier`：把 loader 要的 URL 换成 blob URL。`FBXLoader` 只留文件名、DAE / 3DS 给
 *    相对路径，`urlFor` 两把键都认；认不出来的原样返回（网络贴图 / 内嵌 blob 都不动）；
 * 2. `tga` / `dds` 浏览器 `<img>` 解不了，按需注册 three 的专用 loader ——
 *    `FBXLoader` 在 `manager.getHandler('.tga')` 为空时会**整张贴图跳过**。
 */
async function applyLocalTextures(
  manager: THREE.LoadingManager,
  textures: ModelTextures | null | undefined,
): Promise<void> {
  if (!textures) return
  manager.setURLModifier((url) => textures.urlFor(url))
  if (textures.extensions.has('tga')) {
    const { TGALoader } = await import('three/examples/jsm/loaders/TGALoader.js')
    manager.addHandler(/\.tga$/i, new TGALoader(manager))
  }
  if (textures.extensions.has('dds')) {
    const { DDSLoader } = await import('three/examples/jsm/loaders/DDSLoader.js')
    manager.addHandler(/\.dds$/i, new DDSLoader(manager))
  }
}

/** 非 PBR 材质（FBX / DAE / 3DS / WRL / OBJ 都只产出这两种） */
export interface NonPbrMaterialLike {
  isMeshLambertMaterial?: boolean
  isMeshPhongMaterial?: boolean
  shininess?: number
  /** FBX `ReflectionFactor`：Blender 把 Principled 的 Metallic 写在这里 */
  reflectivity?: number
  [key: string]: unknown
}

function isNonPbr(material: unknown): material is NonPbrMaterialLike {
  const record = material as NonPbrMaterialLike | null
  return !!record && !!(record.isMeshPhongMaterial || record.isMeshLambertMaterial)
}

/**
 * Blinn-Phong 的 `shininess` → GGX `roughness`：`alpha = sqrt(2 / (shininess + 2))`。
 * 只给「不是 Blender 导出」的 FBX 用（那种导出器没有可验证的换算，取通用近似）。
 */
export function shininessToRoughness(shininess: number | undefined): number {
  const exponent = Math.max(shininess ?? 0, 0)
  return Math.min(Math.max(Math.sqrt(2 / (exponent + 2)), 0.06), 1)
}

/**
 * Blender 的 FBX 导出器写的是 `ShininessExponent = 100·(1-roughness)²`（实测 0.2→64、0.1→81、
 * 0.88→1.44 全部吻合），取反函数即可精确复原作者填的那个 roughness。
 */
export function blenderShininessToRoughness(shininess: number | undefined): number {
  const exponent = Math.max(shininess ?? 0, 0)
  return Math.min(Math.max(1 - Math.sqrt(exponent / 100), 0), 1)
}

/** 线性 → sRGB 编码（只为了把 `FBXLoader` 多解的那一次补回去） */
export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055
}

/**
 * FBX 头部的 `Creator` 决定材质数值的口径：Blender（`Blender (stable FBX IO) - …`）把**线性**
 * 颜色写进 `Diffuse`，而 `FBXLoader` 当 sRGB 解 —— 不明说就只能双重解码，整体暗一档。
 * 只扫头部 4KB（`Creator` 在偏移 400 上下），不解析整个 FBX 树。
 */
export function detectBlenderFbx(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4096))
  let text = ''
  for (const byte of head) text += String.fromCharCode(byte)
  return text.includes('Blender (')
}

/** 能搬到 Standard 上的贴图槽（`specularMap` 没有等价物，不搬 —— 搬了会触发 `setValues` 警告） */
const COPIED_TEXTURE_SLOTS = TEXTURE_SLOTS.filter((slot) => slot !== 'specularMap')

/** 换材质时要照抄的字段（贴图槽另按 `TEXTURE_SLOTS` 抄） */
const COPIED_FIELDS = [
  'color',
  'emissive',
  'emissiveIntensity',
  'opacity',
  'transparent',
  'alphaTest',
  'side',
  'shadowSide',
  'flatShading',
  'vertexColors',
  'depthWrite',
  'depthTest',
  'normalScale',
  'bumpScale',
  'displacementScale',
  'displacementBias',
  'name',
] as const

/** `normalizeMaterials` 的选项：只有确认是 Blender 导出的 FBX 才按它的口径反算 */
export interface NormalizeOptions {
  blenderFbx?: boolean
}

/**
 * 金属度来源：
 * - Blender 的 FBX 导出器把 Principled 的 **Metallic 写进 `ReflectionFactor`**（`FBXLoader` 映射成
 *   `material.reflectivity`）—— 实测 racecar 的 13 个材质与 glTF `metallicFactor` 逐位相等；
 * - 其它导出器没这个约定，Phong 本身也没有金属度概念，一律 0（塑料观感，不退化成黑）。
 */
export function metalnessOf(source: NonPbrMaterialLike, options: NormalizeOptions): number {
  if (!options.blenderFbx) return 0
  const value = source.reflectivity
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

/**
 * Phong / Lambert → `MeshStandardMaterial`：预览里所有格式共用一套光照模型（口径 7）。
 *
 * 只搬「有对应概念」的东西：颜色 / 自发光 / 透明度 / 正反面 / 顶点色 / 各类贴图。
 * `specular` 与 `specularMap` 没有等价物（那是另一种着色模型的高光参数），不搬 ——
 * 换成由 `roughness` 决定的物理高光，观感也更接近 GLB。
 */
export function toStandardMaterial(
  THREE: ThreeModule,
  source: NonPbrMaterialLike,
  options: NormalizeOptions = {},
): unknown {
  const parameters: Record<string, unknown> = {
    metalness: metalnessOf(source, options),
    roughness: isLambert(source)
      ? 1
      : options.blenderFbx
        ? blenderShininessToRoughness(source.shininess)
        : shininessToRoughness(source.shininess),
  }
  for (const field of COPIED_FIELDS) {
    const value = source[field]
    if (value === undefined) continue
    // Blender 写的 `Diffuse` / `Emissive` 是线性值，被 `FBXLoader` 当 sRGB 解过一次：编码回去
    parameters[field] =
      options.blenderFbx && (field === 'color' || field === 'emissive')
        ? undoLinearColor(value)
        : value
  }
  for (const slot of COPIED_TEXTURE_SLOTS) {
    const value = source[slot]
    if (!value) continue
    // 颜色贴图必须按 sRGB 解码：法线 / 粗糙度 / AO 是数据，必须留线性（不在这里动）
    if (slot === 'map' || slot === 'emissiveMap') markColorTexture(THREE, value)
    parameters[slot] = value
  }
  return new THREE.MeshStandardMaterial(
    parameters as THREE.MeshStandardMaterialParameters,
  )
}

/**
 * 把颜色贴图标成 sRGB。
 *
 * `FBXLoader` / `VRMLLoader` / `MTLLoader` 会给 `map` 标 `SRGBColorSpace`，
 * **`ColladaLoader` / `TDSLoader` / `ThreeMFLoader` 一个字都不标** —— 它们解出来的贴图保持
 * `NoColorSpace`，采样时不做 sRGB→线性，整张贴图看起来发白。本地贴图接上之后这条才真正可见。
 */
function markColorTexture(THREE: ThreeModule, texture: unknown): void {
  const record = texture as { colorSpace?: string } | null
  if (!record || typeof record !== 'object') return
  if (record.colorSpace === THREE.SRGBColorSpace) return
  record.colorSpace = THREE.SRGBColorSpace
}

/** 把被多解一次的颜色还原成作者写的线性值（不动原实例：材质可能共享） */
function undoLinearColor(color: unknown): unknown {
  const copy = (color as { clone?: () => { r: number; g: number; b: number } }).clone?.()
  if (!copy) return color
  copy.r = linearToSrgb(copy.r)
  copy.g = linearToSrgb(copy.g)
  copy.b = linearToSrgb(copy.b)
  return copy
}

function isLambert(material: NonPbrMaterialLike): boolean {
  return !!material.isMeshLambertMaterial
}

/**
 * 把整棵树上所有 Phong / Lambert 换成 Standard，返回换掉的材质数。
 * 同一份源材质只换一次（多个网格共享材质时保持共享），换完释放原件。
 */
export function normalizeMaterials(
  THREE: ThreeModule,
  object: ObjectTree,
  options: NormalizeOptions = {},
): number {
  const converted = new Map<object, unknown>()
  object.traverse((child) => {
    const mesh = child as MeshLike
    if (!mesh?.isMesh || !mesh.material) return
    const swap = (material: unknown): unknown => {
      if (!isNonPbr(material)) return material
      const cached = converted.get(material)
      if (cached) return cached
      const target = toStandardMaterial(THREE, material, options)
      converted.set(material, target)
      return target
    }
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(swap)
      : swap(mesh.material)
  })
  for (const source of converted.keys()) (source as { dispose?: () => void }).dispose?.()
  return converted.size
}

/** 纯几何格式（STL / PLY）的标准材质：有顶点色就用顶点色，否则给一个中性蓝灰 */
function defaultMaterial(
  THREE: ThreeModule,
  geometry: THREE.BufferGeometry,
): THREE.MeshStandardMaterial {
  const hasColor = !!geometry.attributes.color
  return new THREE.MeshStandardMaterial({
    color: hasColor ? 0xffffff : 0x88a0cc,
    metalness: 0.25,
    roughness: 0.65,
    vertexColors: hasColor,
    // 单面渲染在建模软件导出的「反法线」模型上会整片消失，双面更稳
    side: THREE.DoubleSide,
  })
}

async function wrapGeometry(
  geometry: THREE.BufferGeometry,
  format: ModelExtension,
): Promise<LoadedModel> {
  const THREE = await loadThree()
  const mesh = new THREE.Mesh(geometry, defaultMaterial(THREE, geometry))
  mesh.name = format.toUpperCase()
  return { object: mesh, animations: [], format }
}

/**
 * `.gltf` 是 JSON，可以引外部 `.bin` 与贴图；面板只有一个文件的字节，
 * 这类引用必然失败 —— 提前拦下，比让 loader 抛 `Failed to load buffer` 好懂。
 */
function assertSelfContainedGltf(text: string): void {
  let json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] }
  try {
    json = JSON.parse(text)
  } catch {
    throw new ModelLoadError('unsupported', '这不是有效的 glTF JSON（文件可能已损坏）')
  }
  const external = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((item) => item.uri)
    // `data:` 是内嵌 base64，没有 uri 的是 bufferView（都在文件内）
    .find((uri) => typeof uri === 'string' && uri !== '' && !uri.startsWith('data:'))
  if (external) {
    throw new ModelLoadError(
      'external-resources',
      `这个 .gltf 引用了外部文件 ${external}，只能预览自包含的模型（.glb 或内嵌 base64 的 .gltf）`,
    )
  }
}

/** glTF 材质块里与本文件相关的部分：只判断「金属度有没有被作者声明」 */
export interface GltfMaterialDef {
  pbrMetallicRoughness?: {
    metallicFactor?: number
    roughnessFactor?: number
    metallicRoughnessTexture?: unknown
  }
}

interface GltfRoot {
  materials?: GltfMaterialDef[]
  meshes?: { primitives?: { material?: number }[] }[]
}

/** `GLTFParser.associations` 的值（三个索引里只用得到前三个字段） */
interface GltfAssociation {
  materials?: number
  meshes?: number
  primitives?: number
}

/** `fixUndeclaredMetalness` 的输入：`gltf` 的结构子集，不依赖 three 运行时（便于单测） */
export interface GltfMaterialFixInput {
  scene: { traverse(callback: (child: unknown) => void): void }
  parser: { json?: GltfRoot; associations?: Map<unknown, GltfAssociation> }
}

/**
 * 修掉**作者没声明金属度**的材质 —— GLB 比同款 FBX 暗的主因。
 *
 * glTF 规范里 `metallicFactor` 的缺省值是 **1.0**（不是 0）：材质块没写这一项时，three 把
 * 模型当成「纯金属 + 完全粗糙」。金属的漫反射按 `1 - metalness` 归零，只剩环境反射，
 * 在预览这套「三盏灯 + 弱 IBL」的布光下整片发暗；FBX 走 `MeshPhongMaterial`（没有金属度，
 * 全漫反射），于是「换格式就暗一大截」。
 *
 * ⚠️ 只改「没写」的那一类：显式声明了 `metallicFactor`（铬 / 金…）或挂了金属度贴图的材质
 * 一个字不动 —— 那是作者的真实意图，预览没有资格把它改成非金属。
 */
export function fixUndeclaredMetalness(gltf: GltfMaterialFixInput): void {
  const json = gltf.parser.json
  const associations = gltf.parser.associations
  if (!json || !associations) return

  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    // 按**网格 → primitive** 查材质定义，而不是按材质查：primitive 完全可能没写 `material`
    // （three 会给一个内置 DefaultMaterial，它不进 `json.materials`），那条只有这条路查得到
    const reference = associations.get(mesh)
    const primitive =
      reference?.meshes !== undefined && reference.primitives !== undefined
        ? json.meshes?.[reference.meshes]?.primitives?.[reference.primitives]
        : undefined

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const item of list) {
      const material = item as THREE.MeshStandardMaterial
      // `KHR_materials_unlit` 给的是 MeshBasicMaterial，没有金属度可言
      if (!material?.isMeshStandardMaterial) continue

      const index = primitive?.material ?? associations.get(material)?.materials
      if (index === undefined) {
        // primitive 没写 material：three 用内置 DefaultMaterial（白色 + metalness 1），
        // 一块灰白纯金属，按非金属画
        if (primitive && material.metalness === 1) material.metalness = 0
        continue
      }
      const pbr = json.materials?.[index]?.pbrMetallicRoughness
      // ⚠️ 只认「整块没表达 PBR 意图」：真金属的 `metallicFactor: 1` 恰好等于规范缺省值，
      // 导出端会省掉它 —— 但它一定写了 `roughnessFactor`。只看 metallicFactor 会把真金属
      // 改成非金属（模型反而变亮），所以三个字段都没写才动手。
      if (
        pbr?.metallicFactor !== undefined ||
        pbr?.roughnessFactor !== undefined ||
        pbr?.metallicRoughnessTexture !== undefined
      ) {
        continue
      }
      material.metalness = 0
    }
  })
}

/**
 * 解析器的上下文 = 面板给的选项 + `loadModelFile` 事先备好的本地贴图。
 * 贴图必须在 `parse` 之前就解析完：`setURLModifier` 的回调是**同步**的。
 */
interface ParseContext extends ModelLoadContext {
  textures?: ModelTextures | null
}

type ModelParse = (
  bytes: Uint8Array,
  ext: ModelExtension,
  ctx: ParseContext,
) => Promise<LoadedModel>

/** glb / gltf：Draco 压缩网格 + KTX2 压缩贴图都挂上，解码器随包分发（离线可用） */
const parseGltf: ModelParse = async (bytes, ext, ctx) => {
  const text = ext === 'gltf' ? toText(bytes) : ''
  // 先拦「必然失败」的：为了一个缺 .bin 的 .gltf 去下载三个 chunk 不划算
  if (text) assertSelfContainedGltf(text)

  const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
    import('three/examples/jsm/loaders/KTX2Loader.js'),
  ])
  const loader = new GLTFLoader(await quietManager())
  // ⚠️ 刻意**不调** `setDecoderPath` / `setTranscoderPath`：three 0.186 的默认值就是
  // 模块内的 `new URL('../libs/draco/gltf/…')` / `'../libs/basis/…')`，打包器会把解码器
  // emit 成资产（离线可用，且是 gltf 那份小体积版本）。改成字符串路径会多下一份 500KB 的
  // `draco_decoder.js` 兜底，还要自己搬资源。
  const draco = new DRACOLoader()
  loader.setDRACOLoader(draco)
  const ktx2 = new KTX2Loader()
  if (ctx.renderer) ktx2.detectSupport(ctx.renderer)
  loader.setKTX2Loader(ktx2)

  try {
    return await new Promise<LoadedModel>((resolve, reject) => {
      loader.parse(
        text || toArrayBuffer(bytes),
        '',
        (gltf) => {
          fixUndeclaredMetalness(gltf)
          resolve({ object: gltf.scene, animations: gltf.animations ?? [], format: ext })
        },
        (error) => reject(error),
      )
    })
  } finally {
    // 两个解码器各自持有一个 Worker：解析完就放掉，否则关掉标签页也留着
    draco.dispose()
    ktx2.dispose()
  }
}

const parseFbx: ModelParse = async (bytes, ext, ctx) => {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
  const THREE = await loadThree()
  const manager = await quietManager()
  // 监听要在 parse 之前挂上：贴图的加载项是 parse 期间同步登记的
  const watch = watchTextures(manager, (dropped) => settleTextures(ctx, dropped))
  // 同目录的贴图先读成 blob URL（口径 5）：不可用也不致于让整个模型打不开
  await applyLocalTextures(manager, ctx.textures)
  const buffer = toArrayBuffer(bytes)
  const object = new FBXLoader(manager).parse(buffer, '')
  normalizeMaterials(THREE, object, { blenderFbx: detectBlenderFbx(buffer) })
  watch(object)
  // FBXLoader 把动画挂在返回对象的 `animations` 上（类型里没有）
  const animations = (object as unknown as { animations?: THREE.AnimationClip[] }).animations
  return { object, animations: animations ?? [], format: ext }
}

const parseObj: ModelParse = async (bytes, ext) => {
  const THREE = await loadThree()
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
  const object = new OBJLoader(await quietManager()).parse(toText(bytes))
  // OBJ 的材质来自同名 .mtl（读不到），先归一（Phong → Standard）再补默认材质
  normalizeMaterials(THREE, object)
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    // OBJ 的材质来自同名 .mtl（读不到）：空材质随手补一个，否则整片发黑
    if (!material || (Array.isArray(material) && material.length === 0)) {
      mesh.material = defaultMaterial(THREE, mesh.geometry)
    }
  })
  return { object, animations: [], format: ext }
}

const parseStl: ModelParse = async (bytes, ext) => {
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
  const geometry = new STLLoader(await quietManager()).parse(toArrayBuffer(bytes))
  // 部分 STL 没有法线：不算法线就没有光照，是一块纯色
  if (!geometry.attributes.normal) geometry.computeVertexNormals()
  return await wrapGeometry(geometry, ext)
}

const parsePly: ModelParse = async (bytes, ext) => {
  const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js')
  const geometry = new PLYLoader(await quietManager()).parse(toArrayBuffer(bytes))
  if (!geometry.attributes.normal) geometry.computeVertexNormals()
  return await wrapGeometry(geometry, ext)
}

const parseDae: ModelParse = async (bytes, ext, ctx) => {
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
  const THREE = await loadThree()
  const manager = await quietManager()
  const watch = watchTextures(manager, (dropped) => settleTextures(ctx, dropped))
  await applyLocalTextures(manager, ctx.textures)
  const result = new ColladaLoader(manager).parse(toText(bytes), '')
  normalizeMaterials(THREE, result.scene)
  watch(result.scene)
  return { object: result.scene, animations: result.scene.animations ?? [], format: ext }
}

const parseTds: ModelParse = async (bytes, ext, ctx) => {
  // 注意文件名：类是 `TDSLoader`，文件是 `TDSLoader.js`（与 3MF 的 `3MFLoader.js` 同一目录）
  const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js')
  const THREE = await loadThree()
  const manager = await quietManager()
  const watch = watchTextures(manager, (dropped) => settleTextures(ctx, dropped))
  await applyLocalTextures(manager, ctx.textures)
  const object = new TDSLoader(manager).parse(toArrayBuffer(bytes), '')
  normalizeMaterials(THREE, object)
  watch(object)
  return { object, animations: [], format: ext }
}

const parseThreeMf: ModelParse = async (bytes, ext) => {
  const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js')
  const THREE = await loadThree()
  const object = new ThreeMFLoader().parse(toArrayBuffer(bytes))
  // 3MF 的材质来自切片软件的色块（`MeshPhongMaterial`）：不归一就比其它格式暗一档（口径 7）
  normalizeMaterials(THREE, object)
  return { object, animations: [], format: ext }
}

const parseAmf: ModelParse = async (bytes, ext) => {
  const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js')
  const THREE = await loadThree()
  const object = new AMFLoader().parse(toArrayBuffer(bytes))
  // 同上：AMFLoader 只会造 `MeshPhongMaterial`
  normalizeMaterials(THREE, object)
  return { object, animations: [], format: ext }
}

const parseVrml: ModelParse = async (bytes, ext, ctx) => {
  const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js')
  const THREE = await loadThree()
  const manager = await quietManager()
  const watch = watchTextures(manager, (dropped) => settleTextures(ctx, dropped))
  await applyLocalTextures(manager, ctx.textures)
  const object = new VRMLLoader(manager).parse(toText(bytes), '')
  normalizeMaterials(THREE, object)
  watch(object)
  return { object, animations: [], format: ext }
}

const parsePcd: ModelParse = async (bytes, ext) => {
  const { PCDLoader } = await import('three/examples/jsm/loaders/PCDLoader.js')
  const object = new PCDLoader(await quietManager()).parse(toArrayBuffer(bytes))
  return { object, animations: [], format: ext }
}

/** ⚠️ 必须覆盖 `ModelExtension` 的每一个成员（`Record` 即穷尽检查，见文件头第 1 条） */
const REGISTRY: Record<ModelExtension, ModelParse> = {
  glb: parseGltf,
  gltf: parseGltf,
  fbx: parseFbx,
  obj: parseObj,
  stl: parseStl,
  ply: parsePly,
  dae: parseDae,
  '3ds': parseTds,
  '3mf': parseThreeMf,
  amf: parseAmf,
  wrl: parseVrml,
  vrml: parseVrml,
  pcd: parsePcd,
}

/** 这个扩展名有没有加载器（判定在 `preview.ts`，这里是 fail-closed 兜底） */
export function modelLoaderOf(extension: string): ModelParse | null {
  return REGISTRY[extension as ModelExtension] ?? null
}

/**
 * 可能引用**同目录贴图**的格式：`glb` / `3mf` / `amf` / `ply` / `stl` / `pcd` 的贴图与额外数据都在
 * 文件里，扫了也白扫（0.6MB 的 glb 在磁盘上再无别的依赖）。OBJ 的贴图写在自己的 `.mtl` 里
 * （当前不读 mtl），所以也不在内。
 */
const EXTERNAL_TEXTURE_FORMATS = new Set<ModelExtension>(['fbx', 'dae', '3ds', 'wrl', 'vrml'])

/** 文件名 + 字节 → 可直接塞进场景的对象树 */
export async function loadModelFile(
  bytes: Uint8Array,
  name: string,
  ctx: ModelLoadContext = {},
): Promise<LoadedModel> {
  const ext = extensionOf(name)
  const parse = modelLoaderOf(ext)
  if (!parse) {
    throw new ModelLoadError('unsupported', `不支持的模型格式：.${ext || '(无扩展名)'}`)
  }
  if (bytes.byteLength === 0) {
    throw new ModelLoadError('unsupported', '模型文件是空的')
  }

  // 本地贴图（口径 5）：磁盘路径 + 模型字节 → blob URL。失败一律当「没贴图」，不能挡住模型
  let textures: ModelTextures | null = null
  if (ctx.path && EXTERNAL_TEXTURE_FORMATS.has(ext as ModelExtension)) {
    try {
      textures = await loadModelTextures(bytes, ctx.path, undefined, ctx.report)
    } catch (cause) {
      // 读不到 / 造不出 blob URL：退化成「没有贴图」，不是「打不开模型」——
      // 但得说一句，否则用户只看到纯色而不知道为什么
      textures = null
      ctx.report?.({
        level: 'warning',
        code: 'texture-scan',
        title: DIAGNOSTIC_TITLES['texture-scan'],
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  let loaded: LoadedModel
  try {
    loaded = await parse(bytes, ext as ModelExtension, { ...ctx, textures })
  } catch (error) {
    // 解析失败：blob URL 没人接手了，当场放掉（口径 9）
    textures?.dispose()
    throw error
  }
  if (!textures) return loaded
  // 贴图统计在 `parse` 之后才准确（loader 这一轮才真正开始要文件）：缺的那几张直接进异常日志，
  // 信息面板只给「2 / 3」——用户没法凭它去补文件，名字才能
  const issue = textureDiagnostic(textures.found, textures.total, textures.missing)
  if (issue) ctx.report?.(issue)
  // `requested === 0`：loader 一张都没按磁盘路径来问（贴图全是内嵌的 `data:` / `blob:`，
  // 或者扫到的只是假引用）—— 这时报「0 / 3」只会误导，不给这一行；blob URL 该放的照放（口径 9）
  const stats =
    textures.requested > 0 ? { textures: { found: textures.found, total: textures.total } } : {}
  return {
    ...loaded,
    ...stats,
    dispose: () => {
      loaded.dispose?.()
      textures.dispose()
    },
  }
}
