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
  loadModelFile,
  modelLoaderOf,
  ModelLoadError,
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
