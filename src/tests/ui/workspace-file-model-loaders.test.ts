// @vitest-environment node
/**
 * 3D 预览的两块「不碰 three」的部分：
 * 1. **加载器注册表**（`model-loaders.ts`）—— 扩展名 → loader 的镜像必须与 `domain/files/preview.ts`
 *    的唯一源**完全一致**（那边加一种格式而这边忘了加，面板就会「能打开但画不出来」）；
 * 2. **场景预设**（`model-presets.ts`）—— id 唯一、默认项存在、未知 id 退回默认而不是抛错。
 *
 * 三条在解析前就该失败的口径也钉在这里：不支持的格式 / 空文件 / `.gltf` 引外部资源 ——
 * 它们都在 `import('three')` **之前**抛出，所以本用例不会真的把 three 拉起来。
 */
import { describe, expect, it } from 'vitest'
import { MODEL_EXTENSIONS } from '@/domain/files/preview'
import {
  blenderShininessToRoughness,
  detectBlenderFbx,
  dropUnloadedTextures,
  fixUndeclaredMetalness,
  isTextureUsable,
  linearToSrgb,
  loadModelFile,
  metalnessOf,
  modelLoaderOf,
  ModelLoadError,
  normalizeMaterials,
  shininessToRoughness,
  TEXTURE_SLOTS,
  type GltfMaterialDef,
  type GltfMaterialFixInput,
} from '@/ui/pages/chat/components/workspace-file/model-loaders'
import {
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
  modelPresetOf,
} from '@/ui/pages/chat/components/workspace-file/model-presets'

describe('加载器注册表', () => {
  it('每个可预览的模型扩展名都有加载器（与 preview.ts 的唯一源对齐）', () => {
    for (const extension of MODEL_EXTENSIONS) {
      expect(modelLoaderOf(extension), `缺加载器：${extension}`).toBeTypeOf('function')
    }
  })

  it('不认识的扩展名没有加载器（fail-closed）', () => {
    expect(modelLoaderOf('txt')).toBeNull()
    expect(modelLoaderOf('glbb')).toBeNull()
    expect(modelLoaderOf('')).toBeNull()
  })

  it('不支持的格式 / 空文件：解析前就拒，且带可本地化的 code', async () => {
    await expect(loadModelFile(new Uint8Array([1, 2]), 'a.txt')).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(loadModelFile(new Uint8Array([]), 'a.glb')).rejects.toBeInstanceOf(
      ModelLoadError,
    )
  })

  it('.gltf 引用外部 .bin / 贴图：提前拦下并指出是哪个文件', async () => {
    const text = JSON.stringify({
      buffers: [{ uri: 'scene.bin' }],
      images: [{ uri: 'skin.png' }],
    })

    await expect(
      loadModelFile(new TextEncoder().encode(text), 'a.gltf'),
    ).rejects.toMatchObject({ code: 'external-resources' })
  })
})

describe('场景预设', () => {
  it('id 唯一，且默认项在表里', () => {
    const ids = MODEL_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_MODEL_PRESET_ID)
  })

  it('未知 id 退回默认（存过旧值 / 拼错也不会白屏）', () => {
    expect(modelPresetOf('nope').id).toBe(DEFAULT_MODEL_PRESET_ID)
    expect(modelPresetOf('studio').id).toBe('studio')
  })
})

/**
 * 「GLB 比同款 FBX 暗」的成因：glTF 的 `metallicFactor` 缺省值是 1.0（不是 0），
 * 作者不写这一项时 three 把材质当纯金属，漫反射归零、只剩环境反射。
 * 这里钉住「只修没声明的那一类」，显式金属材质不能被预览改掉。
 */
describe('glTF 未声明金属度的材质', () => {
  type Association = { materials?: number; meshes?: number; primitives?: number }

  /** 够用的假 glTF：`fixUndeclaredMetalness` 只读 traverse / isMesh / material / parser.json·associations */
  function fakeGltf(
    material: Record<string, unknown>,
    defs: GltfMaterialDef[],
    primitive: { material?: number } = { material: 0 },
  ): GltfMaterialFixInput {
    const mesh = { isMesh: true, material }
    const associations = new Map<unknown, Association>([[mesh, { meshes: 0, primitives: 0 }]])
    return {
      scene: { traverse: (visit) => visit(mesh) },
      parser: { json: { materials: defs, meshes: [{ primitives: [primitive] }] }, associations },
    }
  }

  it('只写了 roughnessFactor：视为作者表达过 PBR（真金属会省略 metallicFactor），不动', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1, roughness: 0.4 }
    fixUndeclaredMetalness(
      fakeGltf(material, [{ pbrMetallicRoughness: { roughnessFactor: 0.4 } }]),
    )
    expect(material.metalness).toBe(1)
  })

  it('pbrMetallicRoughness 是空块（导出端什么都没表达）→ 按非金属', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1 }
    fixUndeclaredMetalness(fakeGltf(material, [{ pbrMetallicRoughness: {} }]))
    expect(material.metalness).toBe(0)
  })

  it('连 pbrMetallicRoughness 都没有：同样按非金属', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1 }
    fixUndeclaredMetalness(fakeGltf(material, [{}]))
    expect(material.metalness).toBe(0)
  })

  it('显式写了 metallicFactor：一个字不动（那是作者意图）', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1, roughness: 0.2 }
    fixUndeclaredMetalness(
      fakeGltf(material, [{ pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0.2 } }]),
    )
    expect(material.metalness).toBe(1)
  })

  it('挂了金属度贴图：缺省的 metallicFactor 只是乘数，不得改写', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1 }
    fixUndeclaredMetalness(
      fakeGltf(material, [{ pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } } }]),
    )
    expect(material.metalness).toBe(1)
  })

  it('primitive 没写 material（three 给白色 DefaultMaterial）→ 按非金属', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1, roughness: 1 }
    fixUndeclaredMetalness(fakeGltf(material, [], {}))
    expect(material.metalness).toBe(0)
  })

  it('查不到 primitive（关联缺失）：没有证据就不动', () => {
    const material = { isMeshStandardMaterial: true, metalness: 1 }
    fixUndeclaredMetalness({
      scene: { traverse: (visit) => visit({ isMesh: true, material }) },
      parser: { json: { materials: [{}] }, associations: new Map() },
    })
    expect(material.metalness).toBe(1)
  })

  it('非 PBR 材质（KHR_materials_unlit → MeshBasicMaterial）不碰', () => {
    const material: Record<string, unknown> = { isMeshBasicMaterial: true }
    fixUndeclaredMetalness(fakeGltf(material, []))
    expect(material).not.toHaveProperty('metalness')
  })
})

/**
 * FBX 系材质归一：Phong / Lambert 在 three 里拿不到 IBL 高光（没有 `RE_IndirectSpecular`），
 * 同一份资产换成 GLB（Standard）就明显更亮 —— 预览统一到 Standard 才比得下去。
 */
describe('非 PBR 材质归一到 Standard', () => {
  /** 空实现即可：`toStandardMaterial` 只调构造器，不碰 WebGL */
  function recordingThree() {
    const created: Record<string, unknown>[] = []
    const THREE = {
      MeshStandardMaterial: class {
        constructor(parameters: Record<string, unknown>) {
          created.push(parameters)
        }
      },
    } as unknown as typeof import('three')
    return { THREE, created }
  }

  /** `normalizeMaterials` 只用到 traverse → isMesh → material */
  const tree = (materials: unknown[]) => ({
    traverse: (visit: (child: unknown) => void) =>
      materials.forEach((material) => visit({ isMesh: true, material })),
  })

  const phong = () => ({
    isMeshPhongMaterial: true,
    name: 'skin',
    color: { r: 1 },
    shininess: 30,
    opacity: 0.5,
    transparent: true,
    side: 2,
    vertexColors: true,
    map: { image: {}, version: 1 },
    normalMap: { image: {}, version: 1 },
    specularMap: { image: {}, version: 1 },
  })

  it('Phong → Standard：颜色 / 贴图 / 透明度照搬，高光换成 roughness', () => {
    const { THREE, created } = recordingThree()
    const meshes = [{ material: phong() }]
    const object = {
      traverse: (visit: (child: unknown) => void) =>
        meshes.forEach((mesh) => visit({ isMesh: true, ...mesh })),
    }
    expect(normalizeMaterials(THREE, object)).toBe(1)
    const [parameters] = created
    expect(parameters.name).toBe('skin')
    expect(parameters.opacity).toBe(0.5)
    expect(parameters.transparent).toBe(true)
    expect(parameters.side).toBe(2)
    expect(parameters.vertexColors).toBe(true)
    expect(parameters.map).toBeDefined()
    expect(parameters.normalMap).toBeDefined()
    expect(parameters.metalness).toBe(0)
    expect(parameters.roughness).toBeCloseTo(shininessToRoughness(30), 5)
    // `specularMap` 是另一种着色模型的高光参数，没有等价物
    expect(parameters.specularMap).toBeUndefined()
  })

  it('Lambert → Standard：粗糙度取 1（Lambert 没有高光可言）', () => {
    const { THREE, created } = recordingThree()
    normalizeMaterials(THREE, tree([{ isMeshLambertMaterial: true, color: { r: 1 } }]))
    expect(created[0].roughness).toBe(1)
    expect(created[0].metalness).toBe(0)
  })

  it('已经是 Standard 的（glTF / 纯几何格式）一个不动', () => {
    const { THREE, created } = recordingThree()
    expect(normalizeMaterials(THREE, tree([{ isMeshStandardMaterial: true, metalness: 0.2 }]))).toBe(
      0,
    )
    expect(created).toHaveLength(0)
  })

  it('多个网格共享同一材质：只换一次，仍共享', () => {
    const { THREE, created } = recordingThree()
    const shared = phong()
    const meshes = [{ material: shared }, { material: shared }]
    const object = {
      traverse: (visit: (child: unknown) => void) =>
        meshes.forEach((mesh) => visit({ isMesh: true, ...mesh })),
    }
    expect(normalizeMaterials(THREE, object)).toBe(1)
    expect(created).toHaveLength(1)
  })

  it('shininess → roughness 单调：0 最粗糙，越大越光滑', () => {
    expect(shininessToRoughness(0)).toBeCloseTo(1, 5)
    expect(shininessToRoughness(30)).toBeCloseTo(Math.sqrt(2 / 32), 5)
    expect(shininessToRoughness(1000)).toBeCloseTo(0.06, 5)
    expect(shininessToRoughness(undefined)).toBe(1)
  })
})

/** 贴图加载失败时 `version` 恒为 0，`map` 会把材质乘成黑的（见 `dropUnloadedTextures` 的注释） */
describe('失效贴图槽', () => {
  it('没 image 或从未上传（version 0）→ 摘掉并标记重编译', () => {
    const material: Record<string, unknown> = {
      needsUpdate: false,
      map: { version: 0 },
      normalMap: { image: {} },
      emissiveMap: { image: {}, version: 1 },
    }
    const object = { traverse: (visit: (child: unknown) => void) => visit({ isMesh: true, material }) }
    expect(dropUnloadedTextures(object)).toBe(2)
    expect(material.map).toBeNull()
    expect(material.normalMap).toBeNull()
    expect(material.emissiveMap).not.toBeNull()
    expect(material.needsUpdate).toBe(true)
  })

  it('没有坏槽就不标记重编译（不能白白重建着色器）', () => {
    const material: Record<string, unknown> = {
      needsUpdate: false,
      map: { image: {}, version: 1 },
    }
    const object = { traverse: (visit: (child: unknown) => void) => visit({ isMesh: true, material }) }
    expect(dropUnloadedTextures(object)).toBe(0)
    expect(material.needsUpdate).toBe(false)
  })

  it('isTextureUsable：image 与 version 缺一不可', () => {
    expect(isTextureUsable({ image: {}, version: 1 })).toBe(true)
    expect(isTextureUsable({ image: {}, version: 0 })).toBe(false)
    expect(isTextureUsable({ version: 1 })).toBe(false)
    expect(isTextureUsable(null)).toBe(false)
  })

  it('贴图槽清单是完整的材质贴图集（换材质时照抄靠它）', () => {
    expect(TEXTURE_SLOTS).toContain('map')
    expect(TEXTURE_SLOTS).toContain('aoMap')
    expect(TEXTURE_SLOTS).toContain('envMap')
  })
})

/**
 * Blender 的 FBX 导出器与 glTF 的口径不同（实测 racecar 一对文件逐项对过）：
 * `Diffuse` / `Emissive` 写的是**线性**值（`FBXLoader` 当 sRGB 解 → 双重解码、整体暗一档）；
 * `ShininessExponent = 100·(1-roughness)²`；`ReflectionFactor` = Principled 的 Metallic。
 */
describe('Blender FBX 的数值口径', () => {
  const bytesOf = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer
  }

  it('detectBlenderFbx：认头部 Creator，不扫全文', () => {
    expect(detectBlenderFbx(bytesOf('FBXHeaderExtension Creator Blender (stable FBX IO)'))).toBe(true)
    expect(detectBlenderFbx(bytesOf('FBXHeaderExtension Creator FBX SDK 2020'))).toBe(false)
    // Creator 只在文件尾出现时不算（只看头 4KB）
    expect(detectBlenderFbx(bytesOf('x'.repeat(5000) + 'Blender ('))).toBe(false)
  })

  it('linearToSrgb：0 / 端值 / 中灰', () => {
    expect(linearToSrgb(0)).toBe(0)
    expect(linearToSrgb(1)).toBeCloseTo(1, 6)
    expect(linearToSrgb(0.214)).toBeCloseTo(0.5, 2)
    expect(linearToSrgb(0.001)).toBeCloseTo(0.0129, 3)
  })

  it('blenderShininessToRoughness：100·(1-r)² 的反函数', () => {
    expect(blenderShininessToRoughness(1.44)).toBeCloseTo(0.88, 4)
    expect(blenderShininessToRoughness(43.56)).toBeCloseTo(0.34, 4)
    expect(blenderShininessToRoughness(64)).toBeCloseTo(0.2, 4)
    expect(blenderShininessToRoughness(0)).toBe(1)
    expect(blenderShininessToRoughness(400)).toBe(0)
  })

  it('按 Blender 口径反算：颜色编码回去、粗糙度用 100·(1-r)²、金属度取 ReflectionFactor', () => {
    let captured: Record<string, unknown> = {}
    const THREE = {
      MeshStandardMaterial: class {
        constructor(parameters: Record<string, unknown>) {
          captured = parameters
        }
      },
    } as unknown as typeof import('three')
    const color = { r: 0.0946, g: 0.0009, b: 0.0011, clone() { return { ...this } } }
    const emissive = { r: 0.89, g: 0.933, b: 1, clone() { return { ...this } } }
    const source = {
      isMeshPhongMaterial: true,
      color,
      emissive,
      shininess: 43.56,
      reflectivity: 0.15,
    }
    normalizeMaterials(THREE, { traverse: (visit) => visit({ isMesh: true, material: source }) }, {
      blenderFbx: true,
    })
    const out = captured.color as { r: number; g: number; b: number }
    expect(out.r).toBeCloseTo(0.34, 3)
    expect(out.g).toBeCloseTo(0.011, 2)
    expect((captured.emissive as { r: number }).r).toBeCloseTo(0.95, 2)
    expect(captured.roughness).toBeCloseTo(0.34, 3)
    expect(captured.metalness).toBeCloseTo(0.15, 4)
    // 不能改动共享实例：材质可能在多个网格间共用
    expect(color.r).toBeCloseTo(0.0946, 4)
  })

  it('不是 Blender 的 FBX，保持原口径（颜色不动、金属度 0、通用 GGX 反算）', () => {
    let captured: Record<string, unknown> = {}
    const THREE = {
      MeshStandardMaterial: class {
        constructor(parameters: Record<string, unknown>) {
          captured = parameters
        }
      },
    } as unknown as typeof import('three')
    const source = {
      isMeshPhongMaterial: true,
      color: { r: 0.5, g: 0.5, b: 0.5, clone() { return { ...this } } },
      shininess: 30,
      reflectivity: 1,
    }
    normalizeMaterials(THREE, { traverse: (visit) => visit({ isMesh: true, material: source }) })
    expect((captured.color as { r: number }).r).toBe(0.5)
    expect(captured.metalness).toBe(0)
    expect(captured.roughness).toBeCloseTo(shininessToRoughness(30), 5)
  })

  it('metalnessOf：非法值兑回 0，且夹到 0..1', () => {
    expect(metalnessOf({}, { blenderFbx: true })).toBe(0)
    expect(metalnessOf({ reflectivity: 1 }, {})).toBe(0)
    expect(metalnessOf({ reflectivity: 1 }, { blenderFbx: true })).toBe(1)
    expect(metalnessOf({ reflectivity: 2 }, { blenderFbx: true })).toBe(1)
    expect(metalnessOf({ reflectivity: Number.NaN }, { blenderFbx: true })).toBe(0)
  })
})
