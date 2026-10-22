/**
 * 模型预览的「解析中」：转圈显示、画布藏起来，解析完成后一次性显示。
 *
 * 为什么值得一条用例：`phase === 'loading'` 只持续到 three 解析完，人工看只能看到
 * 「画面上有个东西」；而**画布露不露**这一点肉眼分不清「藏了」还是「本来就是空的」——
 * 露出来的那种会先显示空舞台的网格 / 坐标轴，模型再一块块补上。
 *
 * three 在 jsdom 里起不来（没有 WebGL）：场景与加载器都换成替身（与 `workspace-file-model`
 * 同一手法），只验这两个状态的 DOM 契约。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ModelView from '@/ui/pages/chat/components/workspace-file/model-view'

type LoadedModel = { object: object; animations: never[]; format: string }

let resolveLoad: (model: LoadedModel) => void = () => {}
const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }))

vi.mock('@/ui/pages/chat/components/workspace-file/model-scene', () => {
  class FakeScene {
    applyPreset = vi.fn()
    setModel = vi.fn()
    setWireframe = vi.fn()
    setGrid = vi.fn()
    setAxes = vi.fn()
    setAutoRotate = vi.fn()
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

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <ModelView
        bytes={new Uint8Array([0x67, 0x6c, 0x54, 0x46])}
        name="scene.glb"
        onOpenInSystem={() => {}}
      />,
    ),
  )
  await act(async () => {})
}

beforeEach(() => {
  document.body.innerHTML = ''
  loadMock.mockReset()
  loadMock.mockImplementation(
    () =>
      new Promise<LoadedModel>((resolve) => {
        resolveLoad = resolve
      }),
  )
})

afterEach(() => {
  act(() => root?.unmount())
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
