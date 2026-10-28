/**
 * 3D 预览「网格列表 / 选中模式」的 DOM 契约（three 在 jsdom 里起不来，场景整块换成替身）。
 *
 * 守七件事：
 * 1. **列表来自场景一次**（`listMeshes()`），行里的名称 / 三角形数与场景给的一致；
 * 2. **逐网格显隐真的下发**（`setMeshVisible`）而不是只把行画灰；
 * 3. **选中**：面板点选与画布点选（`setMeshPickHandler` 的回调）都落到同一行，并把 id 交给场景挂高亮；
 *    再点同一块 = 取消选中，关掉选中模式也把选中项置空（详情卡跟着消失）；
 * 4. **单独显示**：其余行一起藏 + 让场景重新取景（否则目标常常只是角落里一小点）；
 * 5. **复制路径**：面板按钮与双击行都复制层级路径 `path`（无名网格复制的是 `车身 > #2`，不是显示名）；
 * 6. **树形列表**：分组行按 `parents` 的层级缩进、默认只展开第一层、折叠不碰显隐、组眼睛按子树下发；
 * 7. **新增文案都在 `en-US.json` 里**（铁律 7）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ModelView from '@/ui/pages/chat/components/workspace-file/model-view'

interface FakeEntry {
  id: string
  index: number
  name: string
  /** 从根到它的每一层父级（含无名组）：树形列表靠它缩进 / 分组 */
  parents: { id: string; name: string }[]
  depth: number
  path: string
  kind: 'mesh' | 'points' | 'line'
  triangles: number
  vertices: number
  materials: number
  size: { x: number; y: number; z: number }
  visible: boolean
}

const hoisted = vi.hoisted(() => ({
  loadMock: vi.fn(),
  copyMock: vi.fn(async () => true),
  /** 场景收到的方法调用（只记这一层关心的几项） */
  visibleCalls: [] as { id: string; visible: boolean }[],
  selectedCalls: [] as (string | null)[],
  selectionModeCalls: [] as boolean[],
  moveModeCalls: [] as boolean[],
  gridCalls: [] as boolean[],
  framedCount: 0,
  focusCount: 0,
  resetCount: 0,
  pickHandlers: [] as ((id: string | null) => void)[],
  meshList: [] as unknown[],
}))

vi.mock('@/ui/pages/chat/components/workspace-file/model-scene', () => {
  class FakeScene {
    applyPreset = vi.fn()
    setModel = vi.fn()
    setWireframe = vi.fn()
    setGrid = vi.fn((on: boolean) => {
      hoisted.gridCalls.push(on)
    })
    setAxes = vi.fn()
    setAutoRotate = vi.fn()
    setModelLights = vi.fn()
    setSelectionMode = vi.fn((on: boolean) => {
      hoisted.selectionModeCalls.push(on)
    })
    setMoveMode = vi.fn((on: boolean) => {
      hoisted.moveModeCalls.push(on)
    })
    setMeshPickHandler = vi.fn((handler: (id: string | null) => void) => {
      hoisted.pickHandlers.push(handler)
    })
    listMeshes = (): unknown[] => hoisted.meshList
    setMeshVisible = vi.fn((id: string, visible: boolean) => {
      hoisted.visibleCalls.push({ id, visible })
    })
    selectMesh = vi.fn((id: string | null) => {
      hoisted.selectedCalls.push(id)
    })
    frameObject = vi.fn(() => {
      hoisted.framedCount += 1
    })
    clearModel = vi.fn()
    /** 「单独显示」只该走这条：只动相机 */
    focusVisible = vi.fn(() => {
      hoisted.focusCount += 1
    })
    resetView = vi.fn(() => {
      hoisted.resetCount += 1
    })
    playAnimation = vi.fn()
    stopAnimations = vi.fn()
    screenshot = vi.fn(() => '')
    dispose = vi.fn()
    getRenderer = (): object => ({})
    getStats = (): object => ({
      meshes: 3,
      triangles: 3600,
      vertices: 2400,
      materials: 2,
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
  loadModelFile: hoisted.loadMock,
}))

vi.mock('@/utils/clipboard', () => ({
  copyText: hoisted.copyMock,
  saveImageAs: vi.fn(async () => ''),
}))

/** Toast 是 body 上的浮层，与这里要验的东西无关（复制成功的提示不抢注意力就行） */
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

function entry(overrides: Partial<FakeEntry> = {}): FakeEntry {
  const index = overrides.index ?? 0
  return {
    id: `mesh-${index}`,
    index,
    name: 'body',
    parents: [],
    depth: 0,
    path: 'body',
    kind: 'mesh',
    triangles: 1200,
    vertices: 800,
    materials: 1,
    size: { x: 1, y: 2, z: 3 },
    visible: true,
    ...overrides,
  }
}

function parent(id: string, name: string): { id: string; name: string } {
  return { id, name }
}

/** 三层套娃：车架（顶层）/ 车身 > 车门 > 无名窗 / 轮子组 > 轮子 */
function treeList(): FakeEntry[] {
  return [
    entry({ index: 0, name: '车架' }),
    entry({
      index: 1,
      name: '车门',
      path: '车身 > 车门',
      parents: [parent('node-0', '车身')],
      depth: 1,
    }),
    entry({
      index: 2,
      name: '',
      path: '车身 > 车门 > #3',
      parents: [parent('node-0', '车身'), parent('node-1', '车门')],
      depth: 2,
    }),
    entry({
      index: 3,
      name: '轮子',
      path: '轮子组 > 轮子',
      parents: [parent('node-2', '轮子组')],
      depth: 1,
    }),
  ]
}

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

/** 工具栏里的文字按钮（面板的入口就在这一排） */
function toolbarButton(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('.wfp-model-toggle')].find(
      (element) => element.textContent === label,
    ) ?? null
  )
}

async function click(element: Element | null | undefined) {
  await act(async () => {
    ;(element as HTMLElement | null)?.click()
  })
}

async function openPanel() {
  await mount()
  await click(toolbarButton('网格列表'))
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.wfp-mesh-row')]
}

/** 分组行（树形列表里的「一层」，与网格行共用 `.wfp-mesh-row`） */
function groupRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.wfp-mesh-row.wfp-mesh-group')]
}

/** 列表里每一行显示的字（分组行带 `[]`，一眼看得出哪些是层） */
function rowNames(): string[] {
  return rows().map((row) => {
    const name = row.querySelector('.wfp-mesh-name')?.textContent ?? ''
    return row.classList.contains('wfp-mesh-group') ? `[${name}]` : name
  })
}

/** 详情卡上的动作按钮（复制路径 / 单独显示 / 取消单独显示 / 取消选中） */
function actionButton(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('.wfp-mesh-action')].find(
      (element) => element.textContent === label,
    ) ?? null
  )
}

/** 最后一个元素（tsconfig 的 lib 没到 es2022，用不了 `Array.prototype.at`） */
function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1]
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  hoisted.visibleCalls.length = 0
  hoisted.selectedCalls.length = 0
  hoisted.selectionModeCalls.length = 0
  hoisted.moveModeCalls.length = 0
  hoisted.gridCalls.length = 0
  hoisted.pickHandlers.length = 0
  hoisted.framedCount = 0
  hoisted.focusCount = 0
  hoisted.resetCount = 0
  hoisted.copyMock.mockClear()
  hoisted.loadMock.mockReset()
  hoisted.loadMock.mockResolvedValue({ object: {}, animations: [], format: 'glb' })
  hoisted.meshList = [
    entry({ index: 0, name: '车身', path: '车身' }),
    // 无名网格：显示名用序号兜底（`网格 2`），path 用语言中立的 `#2`
    entry({ index: 1, name: '', path: '车身 > #2' }),
    entry({ index: 2, name: '轮子', path: '车身 > 轮子' }),
  ]
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('打开面板：每个网格一行，名称 / 三角形数来自场景，无名网格用序号兜底', async () => {
  await openPanel()

  expect(document.querySelector('.wfp-mesh-title')?.textContent).toContain('3')
  const list = rows()
  expect(list).toHaveLength(3)
  expect(list[0].querySelector('.wfp-mesh-name')?.textContent).toBe('车身')
  expect(list[1].querySelector('.wfp-mesh-name')?.textContent).toBe('网格 2')
  // 行里带三角形数（面板一眼就能看出是哪块重）
  expect(list[0].querySelector('.wfp-mesh-tris')?.textContent).toBe('1,200')
  // 完整层级路径在 title 里（重名网格靠它区分）
  expect(list[1].querySelector('.wfp-mesh-name')?.getAttribute('title')).toContain('车身 > #2')
})

it('眼睛按钮：真的把显隐下发给场景，行同时标成 is-hidden', async () => {
  await openPanel()
  await click(rows()[0].querySelector('.wfp-mesh-eye'))

  expect(hoisted.visibleCalls).toEqual([{ id: 'mesh-0', visible: false }])
  expect(rows()[0].className).toContain('is-hidden')
  expect(rows()[0].querySelector('.wfp-mesh-eye')?.getAttribute('aria-pressed')).toBe('true')
})

it('点名称 = 选中：场景挂高亮，详情卡给出这一块自己的统计', async () => {
  await openPanel()
  await click(rows()[1].querySelector('.wfp-mesh-name'))

  expect(hoisted.selectedCalls[hoisted.selectedCalls.length - 1]).toBe('mesh-1')
  expect(document.querySelectorAll('.wfp-mesh-row.is-selected')).toHaveLength(1)

  const detail = document.querySelector('.wfp-mesh-detail')
  expect(detail?.textContent).toContain('网格 2')
  expect(detail?.textContent).toContain('车身 > #2')
  expect(detail?.textContent).toContain('三角形')
  expect(detail?.textContent).toContain('1,200')
  expect(detail?.textContent).toContain('尺寸')
  expect(detail?.textContent).toContain('1.00 × 2.00 × 3.00')
  // 详情卡是舞台上的独立浮层（压右下角）：不能躲在列表面板里跟列表一起滚
  expect(document.querySelector('.wfp-mesh-panel')?.contains(detail ?? null)).toBe(false)
})

it('再点同一行 = 取消选中（详情卡与高亮一起收掉）', async () => {
  await openPanel()
  await click(rows()[0].querySelector('.wfp-mesh-name'))
  expect(document.querySelector('.wfp-mesh-detail')).not.toBeNull()

  await click(rows()[0].querySelector('.wfp-mesh-name'))

  expect(hoisted.selectedCalls[hoisted.selectedCalls.length - 1]).toBe(null)
  expect(document.querySelectorAll('.wfp-mesh-row.is-selected')).toHaveLength(0)
  expect(document.querySelector('.wfp-mesh-detail')).toBeNull()
})

it('没开列表面板也能看到选中详情（画布点选后直接看得到那一块的统计）', async () => {
  await mount()
  // 面板未开：画布点选（选中模式）→ 回调直接落到选中态
  await act(async () => last(hoisted.pickHandlers)?.('mesh-1'))

  expect(document.querySelector('.wfp-mesh-panel')).toBeNull()
  expect(document.querySelector('.wfp-mesh-detail')?.textContent).toContain('车身 > #2')
})

it('复制路径：按钮与双击行都复制层级路径（无名网格复制的是 `车身 > #2`）', async () => {
  await openPanel()
  await click(rows()[0].querySelector('.wfp-mesh-name'))
  const copy = [...document.querySelectorAll<HTMLElement>('.wfp-mesh-action')].find(
    (element) => element.textContent === '复制路径',
  )
  await click(copy)
  expect(hoisted.copyMock).toHaveBeenCalledWith('车身')

  // 无名网格：复制的是能对回模型层级的整条路径，而不是列表里那个兑底显示名
  hoisted.copyMock.mockClear()
  await act(async () => {
    rows()[1]
      .querySelector('.wfp-mesh-name')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  expect(hoisted.copyMock).toHaveBeenCalledWith('车身 > #2')
})

it('单独显示：其余网格一起藏，镜头只贴到这一块（不动模型变换）', async () => {
  await openPanel()
  await click(rows()[2].querySelector('.wfp-mesh-name'))
  const isolate = [...document.querySelectorAll<HTMLElement>('.wfp-mesh-action')].find(
    (element) => element.textContent === '单独显示',
  )
  await click(isolate)

  expect(hoisted.visibleCalls).toEqual([
    { id: 'mesh-0', visible: false },
    { id: 'mesh-1', visible: false },
  ])
  expect(hoisted.focusCount).toBe(1)
  // 绝不能用 `frameObject`：它会重新缩放 / 平移整棵树，模型就离开地面了（且回不去）
  expect(hoisted.framedCount).toBe(0)
  expect(hoisted.selectedCalls[hoisted.selectedCalls.length - 1]).toBe('mesh-2')
})

it('单独显示后，详情卡里那颗按钮变成「显示全部」（不打开列表面板也退得回去）', async () => {
  await openPanel()
  await click(rows()[2].querySelector('.wfp-mesh-name'))
  await click(actionButton('单独显示'))
  // 就是刚刚点过的那一颗：原地变成退出入口
  expect(actionButton('单独显示')).toBeNull()
  expect(actionButton('显示全部')).not.toBeNull()

  // 关掉列表面板：入口依然在（这就是这次要修的东西）
  await click(toolbarButton('网格列表'))
  expect(document.querySelector('.wfp-mesh-panel')).toBeNull()

  hoisted.visibleCalls.length = 0
  await click(actionButton('显示全部'))

  expect(hoisted.visibleCalls).toEqual([
    { id: 'mesh-0', visible: true },
    { id: 'mesh-1', visible: true },
  ])
  // 退回时镜头也收回全模型（单独显示把它贴到那一块了）
  expect(hoisted.resetCount).toBe(1)
  // 退回去之后按钮变回「单独显示」
  expect(actionButton('单独显示')).not.toBeNull()
  expect(actionButton('显示全部')).toBeNull()
})

it('手动改显隐就退出了单独显示状态（详情卡按钮变回「单独显示」）', async () => {
  await openPanel()
  await click(rows()[2].querySelector('.wfp-mesh-name'))
  await click(actionButton('单独显示'))
  expect(actionButton('显示全部')).not.toBeNull()

  await click(rows()[0].querySelector('.wfp-mesh-eye'))

  expect(actionButton('单独显示')).not.toBeNull()
  expect(actionButton('显示全部')).toBeNull()
})

it('显示全部：把藏起来的行一起点亮（只下发真正变了的那些），并把镜头收回全模型', async () => {
  await openPanel()
  await click(rows()[0].querySelector('.wfp-mesh-eye'))
  hoisted.visibleCalls.length = 0

  await click(document.querySelector('.wfp-mesh-all'))

  expect(hoisted.visibleCalls).toEqual([{ id: 'mesh-0', visible: true }])
  expect(rows()[0].className).not.toContain('is-hidden')
  // 取景按全部网格算、不看显隐：这一步只会把相机拉回全模型，模型位置一字不变
  expect(hoisted.resetCount).toBe(1)
})

it('画布点选（选中模式）→ 列表的选中行跟着变', async () => {
  await openPanel()
  const handler = last(hoisted.pickHandlers)
  expect(handler).toBeTypeOf('function')

  await act(async () => handler?.('mesh-2'))

  expect(document.querySelector('.wfp-mesh-row.is-selected .wfp-mesh-name')?.textContent).toBe(
    '轮子',
  )
})

it('工具栏「选择」把选中模式下发给场景（关掉时也要下发，否则光标留着十字）', async () => {
  await mount()
  expect(last(hoisted.selectionModeCalls)).toBe(false)

  await click(toolbarButton('选择'))
  expect(last(hoisted.selectionModeCalls)).toBe(true)
})

it('关掉选中模式 = 选中项置空（高亮框与详情卡一起收掉）', async () => {
  await openPanel()
  await click(toolbarButton('选择'))
  await click(rows()[1].querySelector('.wfp-mesh-name'))
  expect(document.querySelector('.wfp-mesh-detail')?.textContent).toContain('车身 > #2')

  await click(toolbarButton('选择'))

  expect(last(hoisted.selectionModeCalls)).toBe(false)
  expect(hoisted.selectedCalls[hoisted.selectedCalls.length - 1]).toBe(null)
  expect(document.querySelectorAll('.wfp-mesh-row.is-selected')).toHaveLength(0)
  expect(document.querySelector('.wfp-mesh-detail')).toBeNull()
})

it('一个网格都没有：面板给一句人话，而不是一张空表', async () => {
  hoisted.meshList = []
  await openPanel()

  expect(rows()).toHaveLength(0)
  expect(document.querySelector('.wfp-mesh-empty')?.textContent).toContain('这个模型里没有网格')
})

it('树形列表：分组行按层级缩进，默认只展开第一层（深层的组收起来）', async () => {
  hoisted.meshList = treeList()
  await openPanel()

  // 顶层：车架 + 两个顶层分组；里面再套的「车门」组行还在，但它的子项（第三层）折在里面
  expect(rowNames()).toEqual(['车架', '[车身]', '车门', '[车门]', '[轮子组]', '轮子'])
  // 默认展开态：顶层组开着、嵌套组折起（aria-expanded 就是这件事）
  expect(groupRows()[0].querySelector('.wfp-mesh-twist')?.getAttribute('aria-expanded')).toBe(
    'true',
  )
  expect(groupRows()[1].querySelector('.wfp-mesh-twist')?.getAttribute('aria-expanded')).toBe(
    'false',
  )
  // 分组行右边那列是**整组**的三角形合计（折起来时就看这一行）
  expect(groupRows()[0].querySelector('.wfp-mesh-tris')?.textContent).toBe('2,400')
  // 缩进是行内的（层级来自数据，不是按行号猜）；子网格让出一个箭头的宽度，眼睛与父组对齐
  expect(groupRows()[0].style.paddingLeft).toBe('2px')
  expect(rows()[2].style.paddingLeft).toBe('28px')
})

it('折叠箭头：收起 / 展开子树，只动折叠态不碰显隐', async () => {
  hoisted.meshList = treeList()
  await openPanel()

  await click(groupRows()[0].querySelector('.wfp-mesh-twist'))
  expect(rowNames()).toEqual(['车架', '[车身]', '[轮子组]', '轮子'])
  expect(groupRows()[0].querySelector('.wfp-mesh-twist')?.getAttribute('aria-expanded')).toBe(
    'false',
  )
  expect(hoisted.visibleCalls).toEqual([])

  await click(groupRows()[0].querySelector('.wfp-mesh-twist'))
  expect(rowNames()).toEqual(['车架', '[车身]', '车门', '[车门]', '[轮子组]', '轮子'])

  // 嵌套的分组（车门）再展开一层：第三层那个无名窗才出来
  await click(groupRows()[1].querySelector('.wfp-mesh-twist'))
  expect(rowNames()).toEqual([
    '车架',
    '[车身]',
    '车门',
    '[车门]',
    '网格 3',
    '[轮子组]',
    '轮子',
  ])
})

it('组眼睛：整组（含子分组里的网格）一起下发，行同时标成 is-hidden', async () => {
  hoisted.meshList = treeList()
  await openPanel()

  await click(groupRows()[0].querySelector('.wfp-mesh-eye'))

  // 折在里面的那个无名窗也要一起藏：树只影响「看得见哪几行」，显隐按子树算
  expect(hoisted.visibleCalls).toEqual([
    { id: 'mesh-1', visible: false },
    { id: 'mesh-2', visible: false },
  ])
  expect(groupRows()[0].className).toContain('is-hidden')
})

it('无名组用「分组 n」兜底（n 是整张列表里的序号）', async () => {
  hoisted.meshList = [
    entry({ index: 0, name: 'a', parents: [parent('node-0', '')], depth: 1 }),
    entry({ index: 1, name: 'b', parents: [parent('node-1', '车身')], depth: 1 }),
  ]
  await openPanel()

  expect(groupRows().map((row) => row.querySelector('.wfp-mesh-name')?.textContent)).toEqual([
    '分组 1',
    '车身',
  ])
})

it('整组藏起来时，正在选中的那一块一起取消选中', async () => {
  hoisted.meshList = treeList()
  await openPanel()
  await click(rows()[2].querySelector('.wfp-mesh-name'))
  expect(document.querySelector('.wfp-mesh-detail')).not.toBeNull()

  await click(groupRows()[0].querySelector('.wfp-mesh-eye'))

  expect(hoisted.selectedCalls[hoisted.selectedCalls.length - 1]).toBe(null)
  expect(document.querySelector('.wfp-mesh-detail')).toBeNull()
})

it('「更多」菜单：五个低频开关 + 截图都在里面（开着的打勾），点一下就真的下发', async () => {
  await mount()

  await click(document.querySelector('.wfp-model-more'))
  const menuItems = [...document.querySelectorAll<HTMLElement>('.context-menu-item')]
  // 移动模式 / 网格 / 坐标轴 / 自动旋转 / 模型灯光 默认关（只有网格开）；截图是个动作
  expect(menuItems.map((element) => element.textContent)).toEqual([
    '移动模式',
    '✓网格',
    '坐标轴',
    '自动旋转',
    '模型灯光',
    '截图',
  ])

  hoisted.gridCalls.length = 0
  // 按文案取，不按下标：菜单以后加项不该连带改这条用例
  const gridItem = menuItems.find((element) => element.textContent?.includes('网格'))
  await click(gridItem)
  expect(last(hoisted.gridCalls)).toBe(false)
  // 动作完菜单自己关掉
  expect(document.querySelector('.context-menu')).toBeNull()
})

it('移动模式：打开后场景接管镜头，画布上给出操作提示', async () => {
  await mount()

  await click(document.querySelector('.wfp-model-more'))
  const moveItem = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(
    (element) => element.textContent?.includes('移动模式'),
  )
  await click(moveItem)

  expect(last(hoisted.moveModeCalls)).toBe(true)
  // 提示是唯一能告诉用户「WASD 能用」的地方（界面上没有别的入口）
  expect(document.querySelector('.wfp-model-move-hint')?.textContent).toContain('WASD')
})

it('新增文案都在 en-US.json 里（铁律 7）', () => {
  const en = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/ui/i18n/lang/en-US.json'), 'utf8'),
  ) as Record<string, string>
  const keys = [
    '网格列表',
    '网格列表（$__n__）',
    '网格 $__n__',
    '点击画布上的网格即可选中',
    '单击选中，双击复制路径',
    '隐藏这个网格',
    '显示这个网格',
    '隐藏这一组网格',
    '显示这一组网格',
    '展开分组',
    '折叠分组',
    '分组 $__n__',
    '$__n__ 个网格',
    '显示全部',
    '这个模型里没有网格',
    '复制路径',
    '已复制路径到剪贴板',
    '单独显示',
    '取消选中',
    '移动模式',
    'WASD 移动 · Q/E 升降 · 按住鼠标拖动转视角',
  ]
  for (const key of keys) expect(en[key], `${key} 未登记到 en-US.json`).toBeTruthy()
})
