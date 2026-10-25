/**
 * 3D 预览的场景预设（`model-presets.ts`）：纯数据，**不 import three**，所以能直接单测。
 *
 * 为什么值得一条用例：下拉框读的就是这份表。id 重了 / 颜色写成 `rgb()` / `env` 拼错，
 * 编译期都不报——表现是「选了某一档没反应」或「环境贴图退回上一档」，肉眼很难归因。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
  modelPresetOf,
} from '@/ui/pages/chat/components/workspace-file/model-presets'

/** three 只认 `#rrggbb`（`new THREE.Color('rgb(...)')` 也能解析，但预设表统一用十六进制） */
const HEX = /^#[0-9a-f]{6}$/i

describe('场景预设 · 数据完整性', () => {
  it('id 唯一，且默认档在表里', () => {
    const ids = MODEL_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_MODEL_PRESET_ID)
  })

  it('所有颜色都是 #rrggbb（拼错的色值不会报错，只会渲染成黑色）', () => {
    for (const preset of MODEL_PRESETS) {
      const colors = [
        preset.background,
        preset.ground,
        preset.envTop,
        preset.envBottom,
        preset.hemi.sky,
        preset.hemi.ground,
        preset.sun.color,
        preset.fill.color,
        preset.grid.center,
        preset.grid.grid,
      ]
      for (const color of colors) expect(color, `${preset.id}: ${color}`).toMatch(HEX)
    }
  })

  it('环境来源只允许缺省（渐变）或 room', () => {
    for (const preset of MODEL_PRESETS) {
      expect(['undefined', 'gradient', 'room']).toContain(String(preset.env))
    }
    // 至少有一档用摄影棚：渐变的反射没有柔光箱形状，「判材质」时不够用
    expect(MODEL_PRESETS.some((preset) => preset.env === 'room')).toBe(true)
  })

  it('id 失效时退回默认档，不抛错（存过旧值 / 拼错）', () => {
    expect(modelPresetOf('nope').id).toBe(DEFAULT_MODEL_PRESET_ID)
    expect(modelPresetOf('moonlight').id).toBe('moonlight')
  })
})
