/**
 * Markdown 正文里的图片组件。
 *
 * 要点：远程 / data 直出（不碰磁盘）、本地路径读盘后换成 blob、读不到时给「原因 + 原始地址」，
 * 点击放大与右键菜单和消息气泡里发出去的图保持一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { loadMock, previewMock, copyMock, revealMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  previewMock: vi.fn(),
  copyMock: vi.fn(),
  revealMock: vi.fn(),
}))

vi.mock('@/services/local-image-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/local-image-service')>()
  return { ...actual, loadLocalImage: loadMock }
})
vi.mock('@/ui/components/shared/ImagePreview', () => ({ showImagePreview: previewMock }))
vi.mock('@/utils/clipboard', () => ({ copyText: copyMock }))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: revealMock }))

import LocalImage from '@/ui/components/shared/LocalImage'
import { LocalImageError } from '@/services/local-image-service'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const IMAGE = {
  url: 'blob:mock/1',
  mime: 'image/png',
  name: 'a.png',
  absolutePath: 'E:/work/a.png',
}

let root: Root | null = null
let host: HTMLDivElement | null = null

async function mount(props: { src?: string; alt?: string; title?: string }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = async (next: typeof props) => {
    await act(async () => {
      root!.render(<LocalImage {...next} />)
    })
  }
  await render(props)
  return { render }
}

/** 等过 `LOAD_DELAY_MS`（80ms）那一拍 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140))
  })
}

const imgEl = () => host!.querySelector('img') as HTMLImageElement | null
const menuLabels = () =>
  [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent)

async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }),
    )
  })
}

beforeEach(() => {
  loadMock.mockReset()
  previewMock.mockReset()
  copyMock.mockReset()
  revealMock.mockReset()
  copyMock.mockResolvedValue(true)
  revealMock.mockResolvedValue(undefined)
  loadMock.mockResolvedValue(IMAGE)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  host = null
  root = null
})

describe('LocalImage', () => {
  it('http 图片直接交给 <img>，不经过本地读取', async () => {
    await mount({ src: 'https://example.com/a.png', alt: '截图' })

    expect(imgEl()?.getAttribute('src')).toBe('https://example.com/a.png')
    expect(imgEl()?.getAttribute('alt')).toBe('截图')
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('data: 也同样直出（react-markdown 的默认清洗会把它清空，这里必须能过）', async () => {
    await mount({ src: 'data:image/png;base64,AAAA' })

    expect(imgEl()?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('本地相对路径：先占位，读盘成功后换成 blob URL', async () => {
    await mount({ src: './shots/a.png' })

    expect(host!.querySelector('.md-image-loading')).not.toBeNull()
    expect(loadMock).not.toHaveBeenCalled()

    await settle()

    expect(loadMock).toHaveBeenCalledWith('./shots/a.png', undefined)
    expect(imgEl()?.getAttribute('src')).toBe(IMAGE.url)
    expect(host!.querySelector('.md-image-loading')).toBeNull()
  })

  it('file:// 地址先归一成盘符路径再读', async () => {
    await mount({ src: 'file:///C:/code/a.png' })
    await settle()

    expect(loadMock).toHaveBeenCalledWith('C:/code/a.png', undefined)
  })

  it('读不到/不是图片：给出原因与原始地址，而不是一片空白', async () => {
    loadMock.mockRejectedValue(new LocalImageError('not-image', '不是图片'))

    await mount({ src: 'C:/code/a.txt' })
    await settle()

    expect(host!.querySelector('.md-image-failed')?.textContent).toContain('不是图片文件')
    expect(host!.querySelector('.md-image-failed-src')?.textContent).toBe('C:/code/a.txt')
    expect(imgEl()).toBeNull()
  })

  it('空地址直接提示，不去读盘', async () => {
    await mount({ src: '  ' })
    await settle()

    expect(host!.querySelector('.md-image-failed')?.textContent).toContain('图片地址为空')
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('点击放大用 blob URL（不是本地路径），且不会让外层链接跟着跳转', async () => {
    await mount({ src: './a.png' })
    await settle()

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => {
      imgEl()!.dispatchEvent(event)
    })

    expect(previewMock).toHaveBeenCalledWith({ src: IMAGE.url })
    // 图片常被包在链接里（`[![alt](a.png)](url)`）：放大看就行，别顺手打开链接
    expect(event.defaultPrevented).toBe(true)
  })

  it('src 换了但还没读完时，不拿上一张图充数', async () => {
    const view = await mount({ src: './a.png' })
    await settle()
    expect(imgEl()?.getAttribute('src')).toBe(IMAGE.url)

    // 第二张读盘挂在半路
    let resolveSecond: (value: typeof IMAGE) => void = () => {}
    loadMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSecond = resolve
      }),
    )
    await view.render({ src: './b.png' })

    // 立刻：不能还是 a 的 blob，要退回占位
    expect(imgEl()).toBeNull()
    expect(host!.querySelector('.md-image-loading')).not.toBeNull()

    await settle()
    await act(async () => {
      resolveSecond({ ...IMAGE, url: 'blob:mock/2', name: 'b.png' })
      await Promise.resolve()
    })
    expect(imgEl()?.getAttribute('src')).toBe('blob:mock/2')
  })

  it('右键本地图：复制图片 / 另存为 / 在文件管理器中显示 / 复制路径', async () => {
    await mount({ src: './a.png' })
    await settle()

    await rightClick(imgEl()!)

    expect(menuLabels()).toEqual([
      '复制图片',
      '另存为',
      '在文件管理器中显示',
      '复制路径',
    ])

    const items = document.querySelectorAll<HTMLElement>('.context-menu-item')
    await act(async () => {
      items[3].click()
    })

    expect(copyMock).toHaveBeenCalledWith('E:/work/a.png')
  })

  it('右键远程图只有图片本体的两项（没有本地路径可操作）', async () => {
    await mount({ src: 'https://example.com/a.png' })

    await rightClick(imgEl()!)

    expect(menuLabels()).toEqual(['复制图片', '另存为'])
  })
})
