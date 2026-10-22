/**
 * 3D 预览的场景预设（**纯数据**：不 import three，也不碰 DOM）。
 *
 * 为什么单独一个文件：预设要同时被两个地方读 ——
 * 1. React 组件（`model-view.tsx` 画下拉框）静态 import 它；
 * 2. 场景管理器（`model-scene.ts` 的 `applyPreset`）动态 import 时读同一份。
 * 合到 `model-scene.ts` 里的话，下拉框就得把整个 three 造进主包。
 *
 * 三套预设的取舍：面板只有几百像素宽，天空穹顶 / 程序化草地那类「观赏性背景」不划算
 * （见参考实现 `C:\code\demo\3d-preview` 的 presets），这里只保留真正影响「看清模型」的四件事：
 * 背景色、**环境反射贴图**（金属 / 粗糙材质没它是一片死灰）、三盏灯的色温、曝光。
 */
export interface ModelPreset {
  id: string
  /** 文案 key（中文即 key，走 `t()`） */
  label: string
  /** 无天空时的纯色背景 */
  background: string
  /** 接收阴影的地面基色 */
  ground: string
  /** 渐变环境反射：顶部色 / 底部色（equirect → PMREM） */
  envTop: string
  envBottom: string
  hemi: { sky: string; ground: string; intensity: number }
  sun: { color: string; intensity: number; position: [number, number, number] }
  fill: { color: string; intensity: number; position: [number, number, number] }
  exposure: number
  grid: { center: string; grid: string }
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'dark',
    label: '深色',
    background: '#0e1116',
    ground: '#15181d',
    envTop: '#2b3242',
    envBottom: '#05070a',
    hemi: { sky: '#cfd8ff', ground: '#0a0c10', intensity: 0.55 },
    sun: { color: '#ffffff', intensity: 2.0, position: [5, 8, 6] },
    fill: { color: '#7f9cff', intensity: 0.45, position: [-6, 4, -4] },
    exposure: 1,
    grid: { center: '#3a4250', grid: '#232833' },
  },
  {
    id: 'studio',
    label: '灰白',
    background: '#d8dde3',
    ground: '#c4c9cf',
    envTop: '#ffffff',
    envBottom: '#b0b6be',
    hemi: { sky: '#ffffff', ground: '#a0a4ac', intensity: 1 },
    sun: { color: '#ffffff', intensity: 2.2, position: [4, 8, 5] },
    fill: { color: '#c0d0ff', intensity: 0.5, position: [-5, 4, -3] },
    exposure: 1,
    grid: { center: '#8a929c', grid: '#aab0b8' },
  },
  {
    id: 'dusk',
    label: '黄昏',
    background: '#1d1413',
    ground: '#2a1a14',
    envTop: '#ff9a5a',
    envBottom: '#24100c',
    hemi: { sky: '#ffb074', ground: '#2a1a12', intensity: 0.7 },
    sun: { color: '#ff9a4a', intensity: 2.8, position: [9, 2.5, 4] },
    fill: { color: '#6a5aff', intensity: 0.5, position: [-6, 4, -3] },
    exposure: 1.05,
    grid: { center: '#4a3320', grid: '#2a1c14' },
  },
]

/**
 * 默认「灰白」：中性白环境最能看清材质本色（深色 / 黄昏当风格选项）；
 * toolbar 的第一个下拉显式显示它，不靠隐式默认
 */
export const DEFAULT_MODEL_PRESET_ID = 'studio'

/** 按 id 取预设；id 失效（存过旧值 / 拼错）时退回默认，不抛错 */
export function modelPresetOf(id: string): ModelPreset {
  return (
    MODEL_PRESETS.find((preset) => preset.id === id) ??
    MODEL_PRESETS.find((preset) => preset.id === DEFAULT_MODEL_PRESET_ID) ??
    MODEL_PRESETS[0]
  )
}
