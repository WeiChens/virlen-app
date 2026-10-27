/**
 * 模型预览的「解析中」：转圈显示、画布藏起来，解析完成后一次性显示。
 *
 * 为什么值得一条用例：`phase === 'loading'` 只持续到 three 解析完，人工看只能看到
 * 「画面上有个东西」；而**画布露不露**这一点肉眼分不清「藏了」还是「本来就是空的」——
 * 露出来的那种会先显示空舞台的网格 / 坐标轴，模型再一块块补上。
 *
 * three 在 jsdom 里起不来（没有 WebGL）：场景与加载器都换成替身（与 `workspace-file-model`
 * 同一手法），只验这两个状态的 DOM 契约。
 *
 * 后半段是**异常日志**：加载器 / 场景上报的条目要真的进徽标与弹窗，解析失败的原文也要能点开看
 * （模型打不开时，弹窗往往是唯一能说清楚原因的地方）。
 *
 * 最后是**环境（场景预设）**：它全应用一份（`model-environment.ts`），所以两条要验——
 * 新开的预览能不能读到上次存的那一档，以及一处改档其它开着的预览会不会跟着变。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ModelView from '@/ui/pages/chat/components/workspace-file/model-view'
import { MODEL_PRESET_STORAGE_KEY } from '@/ui/pages/chat/components/workspace-file/model-environment'

type LoadedModel = {
  object: object
  animations: never[]
  format: string
  textures?: { found: number; total: number }
  dispose?: () => void
}

let resolveLoad: (model: LoadedModel) => void = () => {}
let rejectLoad: (error: unknown) => void = () => {}
const { loadMock, setModelCalls, appliedPresets } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  /** `setModel(object, animations, report)` 的入参：验第三参（异常上报）真的传下去了 */
  setModelCalls: [] as unknown[][],
  /** 场景收到的预设（`applyPreset` 的实际入参）：验「环境是全局一份」 */
  appliedPresets: [] as unknown[],
}))

vi.mock('@/ui/pages/chat/components/workspace-file/model-scene', () => {
  class FakeScene {
    applyPreset = vi.fn((preset: unknown) => {
      appliedPresets.push(preset)
    })
    setModel = vi.fn().mockImplementation((...args: unknown[]) => {
      setModelCalls.push(args)
    })
    setWireframe = vi.fn()
    setGrid = vi.fn()
    setAxes = vi.fn()
    setAutoRotate = vi.fn()
    setModelLights = vi.fn()
    resetView = vi.fn()
    playAnimation = vi.fn()
    stopAnimations = vi.fn()
    screenshot = vi.fn(() => '')
    dispose = vi.fn()
    getRenderer = () => ({})
    getStats = () => ({
      meshes: 1,
      triangles: 12,
      vertices: 8,
      materials: 1,
      size: { x: 1, y: 2, z: 3 },
    })
  }
  return { ModelScene: FakeScene }
})
vi.mock('@/ui/pages/chat/components/workspace-file/model-loaders', () => ({
  ModelLoadError: class ModelLoadError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  loadModelFile: loadMock,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null
/** 同时挂多个预览（验跨实例同步）：每个 root 单独卸 */
const roots: ReturnType<typeof createRoot>[] = []

async function mount(props: { name?: string; path?: string } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  roots.push(created)
  root = created
  await act(async () =>
    created.render(
      <ModelView
        bytes={new Uint8Array([0x67, 0x6c, 0x54, 0x46])}
        name={props.name ?? 'scene.glb'}
        path={props.path}
        onOpenInSystem={() => {}}
      />,
    ),
  )
  await act(async () => {})
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  appliedPresets.length = 0
  loadMock.mockReset()
  setModelCalls.length = 0
  loadMock.mockImplementation(
    () =>
      new Promise<LoadedModel>((resolve, reject) => {
        resolveLoad = resolve
        rejectLoad = reject
      }),
  )
})

afterEach(() => {
  act(() => {
    for (const created of roots) created.unmount()
  })
  roots.length = 0
  root = null
  document.body.innerHTML = ''
})

it('解析中：转圈盖在舞台上，画布标记为 is-loading（不露空舞台）', async () => {
  await mount()

  const status = document.querySelector('.wfp-model-status')
  expect(status?.querySelector('.wfp-spinner')).not.toBeNull()
  expect(status?.textContent).toContain('正在加载模型')
  expect(document.querySelector('.wfp-model-canvas')?.classList.contains('is-loading')).toBe(true)
})

it('解析完成：转圈与 is-loading 一起收掉（内容一次性显示）', async () => {
  await mount()

  await act(async () => resolveLoad({ object: {}, animations: [], format: 'glb' }))
  await act(async () => {})

  expect(document.querySelector('.wfp-model-status')).toBeNull()
  expect(document.querySelector('.wfp-spinner')).toBeNull()
  expect(document.querySelector('.wfp-model-canvas')?.classList.contains('is-loading')).toBe(false)
})

it('把模型绝对路径交给加载器（同目录的贴图靠它找）', async () => {
  await mount({ name: 'helicopter_textured.fbx', path: 'E:/repo/heli/helicopter_textured.fbx' })

  expect(loadMock).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    'helicopter_textured.fbx',
    expect.objectContaining({ path: 'E:/repo/heli/helicopter_textured.fbx' }),
  )
})

it('模型信息里列出贴图数（找到 / 引用到；少了就说明磁盘上没有那几个文件）', async () => {
  await mount()
  await act(async () =>
    resolveLoad({ object: {}, animations: [], format: 'fbx', textures: { found: 1, total: 2 } }),
  )
  await act(async () => {})

  const toggle = [...document.querySelectorAll<HTMLElement>('.wfp-model-toggle')].find(
    (element) => element.textContent === '模型信息',
  )
  await act(async () => toggle?.click())

  const info = document.querySelector('.wfp-model-info')
  expect(info?.textContent).toContain('贴图')
  expect(info?.textContent).toContain('1 / 2')
})

it('没有外部贴图引用时不显示贴图一行（不能凭空出现一个 0 / 0）', async () => {
  await mount()
  await act(async () => resolveLoad({ object: {}, animations: [], format: 'glb' }))
  await act(async () => {})

  const toggle = [...document.querySelectorAll<HTMLElement>('.wfp-model-toggle')].find(
    (element) => element.textContent === '模型信息',
  )
  await act(async () => toggle?.click())

  expect(document.querySelector('.wfp-model-info')?.textContent).not.toContain('贴图')
})

it('卸载时调 dispose（本地贴图的 blob URL 归它管）', async () => {
  const dispose = vi.fn()
  await mount()
  await act(async () => resolveLoad({ object: {}, animations: [], format: 'fbx', dispose }))
  await act(async () => {})
  expect(dispose).not.toHaveBeenCalled()

  act(() => root?.unmount())
  root = null
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('加载器上报的异常进日志：徽标 = 警告 + 错误条数，点开能看到那一条', async () => {
  loadMock.mockImplementation(async (_bytes, _name, ctx) => {
    ctx.report({
      level: 'warning',
      code: 'texture-missing',
      title: '贴图缺失',
      detail: '1 / 2 · a.png',
    })
    return { object: {}, animations: [], format: 'fbx' }
  })
  await mount()
  await act(async () => {})

  const button = document.querySelector<HTMLElement>('.wfp-model-log-btn')
  expect(button?.querySelector('.wfp-model-log-badge')?.textContent).toBe('1')

  await act(async () => button?.click())
  const item = document.querySelector('.wfp-log-item')
  expect(item?.textContent).toContain('警告')
  expect(item?.textContent).toContain('贴图缺失')
  // detail 不翻译：文件名要能直接拿去补文件
  expect(item?.textContent).toContain('1 / 2 · a.png')

  // 清空：徽标与条目一起消失，弹窗回到空态
  const clear = [...document.querySelectorAll<HTMLElement>('.modal-footer button')].find(
    (element) => element.textContent === '清空',
  )
  await act(async () => clear?.click())
  expect(document.querySelector('.wfp-model-log-badge')).toBeNull()
  expect(document.querySelector('.wfp-log-empty')?.textContent).toContain('没有发现异常')
})

it('解析失败也记进日志（模型打不开时更要能点开看原因）', async () => {
  const { ModelLoadError } = await import(
    '@/ui/pages/chat/components/workspace-file/model-loaders'
  )
  await mount()
  await act(async () => rejectLoad(new ModelLoadError('unsupported', '不支持的模型格式：.txt')))
  await act(async () => {})

  expect(document.querySelector('.wfp-model-log-badge')?.textContent).toBe('1')
  const button = document.querySelector<HTMLElement>('.wfp-model-log-btn')
  await act(async () => button?.click())

  const item = document.querySelector('.wfp-log-item')
  expect(item?.textContent).toContain('错误')
  expect(item?.textContent).toContain('暂不支持该模型格式')
  // 库抛的原文进 detail（排查用）
  expect(item?.textContent).toContain('不支持的模型格式：.txt')
})

it('没有问题：不显示徽标，弹窗是空态', async () => {
  await mount()
  await act(async () => resolveLoad({ object: {}, animations: [], format: 'glb' }))
  await act(async () => {})

  expect(document.querySelector('.wfp-model-log-badge')).toBeNull()
  const button = document.querySelector<HTMLElement>('.wfp-model-log-btn')
  await act(async () => button?.click())
  expect(document.querySelector('.wfp-log-empty')?.textContent).toContain('没有发现异常')
})

it('场景侧的异常（空包围盒、上下文丢失）走同一个日志：第三参就是上报函数', async () => {
  await mount()
  await act(async () => resolveLoad({ object: {}, animations: [], format: 'glb' }))
  await act(async () => {})

  // `setModel(object, animations, report)`：场景在取景 / 上下文丢失时用它上报
  const last = setModelCalls[setModelCalls.length - 1]
  const report = last?.[2] as ((input: unknown) => void) | undefined
  expect(report).toBeTypeOf('function')
  await act(async () =>
    report?.({ level: 'warning', code: 'empty-bounds', title: '模型没有可显示的几何' }),
  )
  expect(document.querySelector('.wfp-model-log-badge')?.textContent).toBe('1')
})

/** 环境下拉的触发值（只有一个 Select：动画下拉只在有 clip 时才出现） */
function presetLabelOf(index = 0): string | undefined {
  return document.querySelectorAll('.custom-select__value')[index]?.textContent ?? undefined
}

it('环境初始值来自 localStorage（上次选的档位，重启 / 换文件都沿用）', async () => {
  localStorage.setItem(MODEL_PRESET_STORAGE_KEY, 'dusk')
  await mount()

  expect(presetLabelOf()).toBe('黄昏')
  // 并且已经应用到场景（不是只把下拉改了个字）
  expect((appliedPresets[appliedPresets.length - 1] as { id: string }).id).toBe('dusk')
})

it('没存过时用默认档（不会因为空存储而空白）', async () => {
  await mount()
  expect(presetLabelOf()).toBe('灰白')
})

it('一处改环境：落盘 + 所有开着的预览一起变（全局一份）', async () => {
  await mount()
  await mount()
  // 建场景时两个实例各应用过一次初始档；之后只该有「这一次切换」的两条
  appliedPresets.length = 0

  const triggers = [...document.querySelectorAll<HTMLElement>('.wfp-model-select')]
  expect(triggers).toHaveLength(2)

  await act(async () => triggers[0].click())
  const option = [...document.querySelectorAll<HTMLElement>('.custom-select__option')].find(
    (element) => element.textContent === '黄昏',
  )
  await act(async () => option?.click())

  // 1) 落盘（重启后还用这一档）
  expect(localStorage.getItem(MODEL_PRESET_STORAGE_KEY)).toBe('dusk')
  // 2) 两个实例的选中值都变了
  expect([presetLabelOf(0), presetLabelOf(1)]).toEqual(['黄昏', '黄昏'])
  // 3) 两个场景都收到了新预设（只管下拉不管渲染就会只剩「字变了」）
  expect((appliedPresets as { id: string }[]).map((preset) => preset.id)).toEqual(['dusk', 'dusk'])
})
