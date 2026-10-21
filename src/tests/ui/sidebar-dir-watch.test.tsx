/**
 * 侧边栏「只监听展开的目录」的对齐逻辑。
 *
 * 守四条：
 * 1. 根 + 每个展开项各一个**非递归** watcher；
 * 2. 折叠只退掉那一个，别的 watcher 不重建（重建会漏事件、也白刷 IPC）；
 * 3. 事件到达只回调「哪个目录变了」，由调用方去重读；
 * 4. 卸载全退；订阅 promise 还没回来就已折叠的，回来时立刻退（不留半条订阅）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { useDirWatchers } from '@/ui/pages/chat/components/sidebar/use-dir-watch'

const { watchMock, watched, stops } = vi.hoisted(() => ({
  watchMock: vi.fn(),
  watched: [] as { dir: string; fire: () => void; stop: ReturnType<typeof vi.fn> }[],
  stops: [] as ReturnType<typeof vi.fn>[],
}))

vi.mock('@tauri-apps/plugin-fs', () => ({ watch: watchMock }))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  dirs,
  onChange,
}: {
  dirs: string[]
  onChange: (dir: string) => void
}): null {
  useDirWatchers(dirs, onChange)
  return null
}

let root: ReturnType<typeof createRoot> | null = null
let changed: string[] = []

async function mount(dirs: string[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (next: string[]) =>
    root!.render(<Harness dirs={next} onChange={(dir) => changed.push(dir)} />)
  await act(async () => render(dirs))
  await act(async () => {})
  return { render }
}

/** dir → 该目录的 fire / stop */
const entryOf = (dir: string) => watched.find((item) => item.dir === dir)

beforeEach(() => {
  watched.length = 0
  stops.length = 0
  changed = []
  watchMock.mockReset()
  watchMock.mockImplementation(async (dir: string, fire: () => void) => {
    const stop = vi.fn()
    stops.push(stop)
    watched.push({ dir, fire, stop })
    return stop
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('根 + 展开项各订阅一个（非递归，带防抖窗口）', async () => {
  await mount(['E:/repo', 'E:/repo/src', 'E:/repo/src/ui'])

  expect(watched.map((item) => item.dir)).toEqual([
    'E:/repo',
    'E:/repo/src',
    'E:/repo/src/ui',
  ])
  expect(watchMock.mock.calls[0][2]).toEqual({ delayMs: 300 })
})

it('折叠只退掉那一个，其余 watcher 原样保留', async () => {
  const { render } = await mount(['E:/repo', 'E:/repo/src', 'E:/repo/src/ui'])
  const rootStop = entryOf('E:/repo').stop
  const srcStop = entryOf('E:/repo/src').stop
  const uiStop = entryOf('E:/repo/src/ui').stop

  await act(async () => render(['E:/repo', 'E:/repo/src']))
  await act(async () => {})

  expect(uiStop).toHaveBeenCalledTimes(1)
  expect(rootStop).not.toHaveBeenCalled()
  expect(srcStop).not.toHaveBeenCalled()
  // 没有为留下的目录重新订阅
  expect(watchMock).toHaveBeenCalledTimes(3)
})

it('新展开一个目录只新增订阅', async () => {
  const { render } = await mount(['E:/repo'])

  await act(async () => render(['E:/repo', 'E:/repo/docs']))
  await act(async () => {})

  expect(watchMock).toHaveBeenCalledTimes(2)
  expect(entryOf('E:/repo/docs')).toBeTruthy()
  expect(stops[0]).not.toHaveBeenCalled()
})

it('事件到达 → 只回调「哪个目录变了」', async () => {
  await mount(['E:/repo', 'E:/repo/src'])

  act(() => entryOf('E:/repo/src').fire())

  expect(changed).toEqual(['E:/repo/src'])
})

it('卸载时全部退订', async () => {
  await mount(['E:/repo', 'E:/repo/src'])
  const [rootStop, srcStop] = [entryOf('E:/repo').stop, entryOf('E:/repo/src').stop]

  act(() => root!.unmount())
  root = null

  expect(rootStop).toHaveBeenCalledTimes(1)
  expect(srcStop).toHaveBeenCalledTimes(1)
})

it('订阅还没回来就折叠了 → 回来时立刻退订（不留半条订阅）', async () => {
  let release: ((stop: () => void) => void) | null = null
  const lateStop = vi.fn()
  watchMock.mockReset()
  watchMock.mockImplementation((dir: string, fire: () => void) => {
    // 让 `src` 这一条一直在飞行中（模拟 watcher 建立得慢），其余立刻回来
    if (dir === 'E:/repo/src') {
      return new Promise<() => void>((resolve) => {
        release = resolve
      })
    }
    const stop = vi.fn()
    watched.push({ dir, fire, stop })
    return Promise.resolve(stop)
  })

  const { render } = await mount(['E:/repo', 'E:/repo/src'])

  // src 的订阅还没回来，用户已经把它折起来了
  await act(async () => render(['E:/repo']))
  await act(async () => {})
  await act(async () => {
    release?.(lateStop)
  })

  expect(lateStop).toHaveBeenCalledTimes(1)
})
