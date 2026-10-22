/**
 * 3D 模型的加载器注册表：**扩展名 → three 的 loader**（面板只把字节交给这一层）。
 *
 * 五条口径：
 * 1. **扩展名的唯一源是 `domain/files/preview.ts`**（`ModelExtension` / `MODEL_EXTENSIONS`）。
 *    下面那张 `Record<ModelExtension, …>` 是穷尽检查：那边加了格式却忘了加加载器，编译期就报错
 *    （铁律 3：双份镜像必须同步，这里用类型系统钉住）。
 * 2. **每种格式各自动态 `import()`**：所有 loader 加起来比应用主包还大，只有真的打开模型才下载
 *    对应的那几个（PDF 预览的 pdfjs 是同一手法，见 `pdf-view.tsx`）。
 * 3. **只处理单文件模型**：面板只拿到**一个文件**的字节，所以 `.gltf` 引用外部 `.bin` / 贴图时
 *    在解析前就拦下并给一句人话（否则 GLTFLoader 抛的是 `Failed to load buffer`）。
 * 4. **纯几何格式补默认材质**：STL / PLY 只有顶点、OBJ 常常没有 mtl，不补就是一片全黑。
 * 5. **贴图一律从字节里出**：FBX / 3DS / DAE 里写的相对贴图路径加载不到，`LoadingManager.onError`
 *    直接吞掉 —— 否则控制台刷一片 404，而模型其实已经画出来了。
 */
import type * as THREE from 'three'
import { extensionOf, type ModelExtension } from '@/domain/files/preview'

/** 加载完成的一个模型 */
export interface LoadedModel {
  object: THREE.Object3D
  /** 动画片段（没有动画的格式为空数组） */
  animations: THREE.AnimationClip[]
  /** 小写扩展名 */
  format: ModelExtension
}

export interface ModelLoadContext {
  /**
   * KTX2 贴图要知道当前 renderer 支持哪种压缩格式（`detectSupport`）；
   * 没有 renderer 就只是解不出 KTX2 贴图，几何与其余贴图照常。
   */
  renderer?: THREE.WebGLRenderer
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

type ModelParse = (
  bytes: Uint8Array,
  ext: ModelExtension,
  ctx: ModelLoadContext,
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

const parseFbx: ModelParse = async (bytes, ext) => {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
  const object = new FBXLoader(await quietManager()).parse(toArrayBuffer(bytes), '')
  // FBXLoader 把动画挂在返回对象的 `animations` 上（类型里没有）
  const animations = (object as unknown as { animations?: THREE.AnimationClip[] }).animations
  return { object, animations: animations ?? [], format: ext }
}

const parseObj: ModelParse = async (bytes, ext) => {
  const THREE = await loadThree()
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
  const object = new OBJLoader(await quietManager()).parse(toText(bytes))
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

const parseDae: ModelParse = async (bytes, ext) => {
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
  const result = new ColladaLoader(await quietManager()).parse(toText(bytes), '')
  return { object: result.scene, animations: result.scene.animations ?? [], format: ext }
}

const parseTds: ModelParse = async (bytes, ext) => {
  // 注意文件名：类是 `TDSLoader`，文件是 `TDSLoader.js`（与 3MF 的 `3MFLoader.js` 同一目录）
  const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js')
  const object = new TDSLoader(await quietManager()).parse(toArrayBuffer(bytes), '')
  return { object, animations: [], format: ext }
}

const parseThreeMf: ModelParse = async (bytes, ext) => {
  const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js')
  const object = new ThreeMFLoader().parse(toArrayBuffer(bytes))
  return { object, animations: [], format: ext }
}

const parseAmf: ModelParse = async (bytes, ext) => {
  const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js')
  const object = new AMFLoader().parse(toArrayBuffer(bytes))
  return { object, animations: [], format: ext }
}

const parseVrml: ModelParse = async (bytes, ext) => {
  const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js')
  const object = new VRMLLoader(await quietManager()).parse(toText(bytes), '')
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
  return await parse(bytes, ext as ModelExtension, ctx)
}
