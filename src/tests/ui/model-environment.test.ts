/**
 * 3D 预览的「环境」（`model-environment.ts`）：**全应用一份 + 落 localStorage**。
 *
 * 为什么值得一条用例：这一份值决定模型看起来是什么颜色，而它的三种失败都是静默的 ——
 * 存过旧档位（预设表改了名）、手改过存储、隐私模式下 localStorage 抛错。任一种没兜住，
 * 表现都是「打开模型直接报错 / 环境全黑」，与「文件坏了」分不清。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_PRESET_STORAGE_KEY,
  readModelPresetId,
  setModelPresetId,
} from '@/ui/pages/chat/components/workspace-file/model-environment'
import {
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
} from '@/ui/pages/chat/components/workspace-file/model-presets'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 隐私模式 / 配额满：整个 `localStorage` 一侧可抛（happy-dom 的实例方法 spy 不住，用 `stubGlobal`） */
function stubLocalStorage(overrides: {
  getItem?: () => string | null
  setItem?: () => void
}): void {
  vi.stubGlobal('localStorage', {
    getItem: overrides.getItem ?? ((): string | null => null),
    setItem: overrides.setItem ?? ((): void => {}),
  })
}

describe('读取', () => {
  it('没存过 → 默认档', () => {
    expect(readModelPresetId()).toBe(DEFAULT_MODEL_PRESET_ID)
  })

  it('存了合法 id → 就用它（重启后沿用）', () => {
    localStorage.setItem(MODEL_PRESET_STORAGE_KEY, 'dusk')
    expect(readModelPresetId()).toBe('dusk')
  })

  it('存了不存在的 id（预设改过名 / 手改存储）→ 退回默认档，不抛', () => {
    localStorage.setItem(MODEL_PRESET_STORAGE_KEY, 'no-such-preset')
    expect(readModelPresetId()).toBe(DEFAULT_MODEL_PRESET_ID)
  })

  it('localStorage 读就抛（隐私模式）→ 默认档，不让预览起不来', () => {
    stubLocalStorage({
      getItem: () => {
        throw new Error('access denied')
      },
    })
    expect(readModelPresetId()).toBe(DEFAULT_MODEL_PRESET_ID)
  })
})

describe('写入', () => {
  it('落盘（只存 id，不存整份预设）', () => {
    setModelPresetId('moonlight')
    expect(localStorage.getItem(MODEL_PRESET_STORAGE_KEY)).toBe('moonlight')
    expect(readModelPresetId()).toBe('moonlight')
  })

  it('未知 id 一律落回默认档（与 `modelPresetOf` 同口径）', () => {
    setModelPresetId('whatever')
    expect(readModelPresetId()).toBe(DEFAULT_MODEL_PRESET_ID)
  })

  it('写不进去也不抛（配额满 / 存储被禁：只是「下次打开忘了选哪档」）', () => {
    stubLocalStorage({
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })
    expect(() => setModelPresetId('moonlight')).not.toThrow()
    // 没落盘 → 下次打开回到默认档（本次会话里的切换照常生效，不依赖存不存得下）
    expect(readModelPresetId()).toBe(DEFAULT_MODEL_PRESET_ID)
  })
})

describe('存储里只放 id', () => {
  it('写进去的值是 `MODEL_PRESETS` 里真有的 id（否则下次读会被当垃圾丢掉）', () => {
    for (const preset of MODEL_PRESETS) {
      setModelPresetId(preset.id)
      expect(MODEL_PRESETS.some((item) => item.id === readModelPresetId())).toBe(true)
    }
  })
})
