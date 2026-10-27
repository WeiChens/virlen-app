/**
 * 3D 预览的**环境**（场景预设）选择：全应用**只有一份**，并记在 localStorage。
 *
 * 为什么不是组件 state：面板的标签是**同时挂着**的（`side-panel` 的 `parkedTabs` 一直不卸载，
 * 常驻标签也只是切显隐），同时开两个模型 = 两个 `ModelView` 实例。各自一份 state 时，
 * 改 A 的环境 B 不知道 —— 用户会以为是「这个模型不支持某档环境」。所以真相放在模块级 store：
 * 任何一处改了，所有预览（含之后新开的）都跟着变，重启应用也还在。
 *
 * 为什么不用 MobX：需求只有「一个字符串 + 通知」，三十行的外部 store 就够，而且
 * `useSyncExternalStore` 是 React 19 里订阅外部数据的正规入口（并发渲染下不会读到撕裂的旧值）。
 *
 * 四条口径：
 * 1. **只存 id，不存整份预设**：预设表是会改的（加档 / 调色 / 删档），存整份会把过期颜色
 *    一直带下去；id 失效（改过名 / 手改了存储）时 `modelPresetOf` 会退回默认档。
 * 2. **示例值必须可判**：`readPresetId` 只认 `MODEL_PRESETS` 里真有的 id，别的一律当没存过。
 * 3. **读写都吞异常**：隐私模式 / 存储被禁 / 配额满时 localStorage 会抛。那只是
 *    「下次打开忘了选哪档」，不能连累预览（更不能让面板白屏）。
 * 4. **不监听 `storage` 事件**：单窗口单 JS 上下文，本模块就是唯一真相；真要支持多窗口同步，
 *    在这里补一个 `window.addEventListener('storage', …)` 即可。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_MODEL_PRESET_ID, MODEL_PRESETS } from './model-presets'

/** localStorage 的键（与 `virlen-git-side-width` 等同一命名风格） */
export const MODEL_PRESET_STORAGE_KEY = 'virlen-model-preset'

/** 订阅者：所有挂着的 `ModelView`（每个实例一个） */
const listeners = new Set<() => void>()

function isPresetId(id: string): boolean {
  return MODEL_PRESETS.some((preset) => preset.id === id)
}

/**
 * 当前环境 id。**每次都读 localStorage**（同步、开销可忽略），不另存一份模块级缓存：
 * 缓存要在每个用例之间手动复位，反而容易让「读到的和存的不一致」这类 bug 藏起来。
 */
export function readModelPresetId(): string {
  try {
    const stored = localStorage.getItem(MODEL_PRESET_STORAGE_KEY)
    if (stored && isPresetId(stored)) return stored
  } catch {
    // 隐私模式 / 存储被禁：当没存过，用默认档
  }
  return DEFAULT_MODEL_PRESET_ID
}

/**
 * 改环境：落盘 + 通知所有实例。值没变时**不通知**（React 会白重渲染一次，场景还会多建一张
 * 环境贴图 —— `applyPreset` 不是免费的）；未知 id 落回默认档，与 `modelPresetOf` 同口径。
 */
export function setModelPresetId(id: string): void {
  const next = isPresetId(id) ? id : DEFAULT_MODEL_PRESET_ID
  if (next === readModelPresetId()) return
  try {
    localStorage.setItem(MODEL_PRESET_STORAGE_KEY, next)
  } catch {
    // 存不下就算了（只是「下次打开忘了选哪档」），本次切换照常生效（还要通知订阅者）
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * React 侧读当前环境。所有 `ModelView` 共用一个值 —— 改一处，开着的预览全部跟着换。
 * 第三个参数（`getServerSnapshot`）给同一个函数：本项目没有 SSR，但 React 的类型要求它。
 */
export function useModelPresetId(): string {
  return useSyncExternalStore(subscribe, readModelPresetId, readModelPresetId)
}
