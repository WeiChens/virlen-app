/**
 * 本地图片读取层：安全校验 → stat → 读盘 → blob URL。
 *
 * 这里守的是「什么该读、什么不该读、读过的别重复读」：
 * 非图片不碰磁盘、超限不读、同一张图第二次直接给缓存的 URL（Markdown 流式渲染会反复挂载）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, readFileMock, resolveSafePathMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveSafePathMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: readFileMock }))
vi.mock('@/services/security-service', () => ({
  securityService: { resolveSafePath: resolveSafePathMock },
}))

import {
  clearLocalImageCache,
  loadLocalImage,
  LocalImageError,
  MAX_IMAGE_BYTES,
  peekCachedImage,
} from '@/services/local-image-service'

const created: string[] = []
const revoked: string[] = []
let seq = 0

// jsdom 没实现 blob URL，这里补一份可断言的假实现
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:mock/${++seq}:${blob.type}`
      created.push(url)
      return url
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => revoked.push(url),
  })
})

function statOf(size: number) {
  invokeMock.mockResolvedValue({ exists: true, is_file: true, size })
}

beforeEach(() => {
  clearLocalImageCache()
  invokeMock.mockReset()
  readFileMock.mockReset()
  resolveSafePathMock.mockReset()
  // 默认原样返回：用例关心的是「路径有没有过校验」，不是拼接规则
  resolveSafePathMock.mockImplementation((path: string) => Promise.resolve(path))
  readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
  created.length = 0
  revoked.length = 0
})

describe('loadLocalImage', () => {
  it('先过安全校验，再 stat + 读盘；mime 按扩展名给', async () => {
    statOf(3)

    const image = await loadLocalImage('./shots/a.png', 's1')

    expect(resolveSafePathMock).toHaveBeenCalledWith('./shots/a.png', 'r', 's1')
    expect(invokeMock).toHaveBeenCalledWith('stat_path', { path: './shots/a.png' })
    expect(readFileMock).toHaveBeenCalledWith('./shots/a.png')
    expect(image).toMatchObject({
      mime: 'image/png',
      name: 'a.png',
      absolutePath: './shots/a.png',
    })
    expect(image.url.startsWith('blob:mock/')).toBe(true)
  })

  it('SVG 也算图片，且 mime 单独给（它在 preview 表里平时是可编辑文本）', async () => {
    statOf(10)

    const image = await loadLocalImage('E:/work/logo.svg')

    expect(image.mime).toBe('image/svg+xml')
  })

  it('非图片扩展名直接拒，一次磁盘都不碰', async () => {
    statOf(10)

    await expect(loadLocalImage('E:/work/a.txt')).rejects.toMatchObject({
      code: 'not-image',
    })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('文件不存在 / 不是文件 / 超过上限 → 各自一个 code', async () => {
    invokeMock.mockResolvedValue(null)
    await expect(loadLocalImage('E:/a.png')).rejects.toMatchObject({ code: 'not-found' })

    invokeMock.mockResolvedValue({ exists: true, is_file: false, size: 10 })
    await expect(loadLocalImage('E:/a.png')).rejects.toMatchObject({ code: 'not-file' })

    invokeMock.mockResolvedValue({
      exists: true,
      is_file: true,
      size: MAX_IMAGE_BYTES + 1,
    })
    await expect(loadLocalImage('E:/a.png')).rejects.toMatchObject({ code: 'too-large' })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('安全校验拒绝时把原因原样抛出（不包装成 not-found）', async () => {
    resolveSafePathMock.mockRejectedValue(new Error('路径不在允许范围内'))

    await expect(loadLocalImage('C:/Windows/a.png')).rejects.toThrow('路径不在允许范围内')
  })

  it('同一路径第二次命中缓存：不再 stat / 读盘，URL 也不变', async () => {
    statOf(3)

    const first = await loadLocalImage('E:/a.png')
    invokeMock.mockClear()
    readFileMock.mockClear()
    const second = await loadLocalImage('E:/a.png')

    expect(second.url).toBe(first.url)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(peekCachedImage('E:/a.png')?.url).toBe(first.url)
  })

  it('不同会话各缓存一份（相对路径的解析基准不同，不能串）', async () => {
    statOf(3)

    const a = await loadLocalImage('a.png', 's1')
    const b = await loadLocalImage('a.png', 's2')

    expect(a.url).not.toBe(b.url)
    expect(peekCachedImage('a.png', 's1')?.url).toBe(a.url)
    expect(peekCachedImage('a.png', 's2')?.url).toBe(b.url)
  })

  it('缓存超出上限时淘汰最旧的并 revoke 它的 blob URL', async () => {
    statOf(3)

    const first = await loadLocalImage('E:/img-0.png')
    for (let i = 1; i < 65; i += 1) await loadLocalImage(`E:/img-${i}.png`)

    expect(peekCachedImage('E:/img-0.png')).toBeUndefined()
    expect(revoked).toContain(first.url)
    // 最近的还在
    expect(peekCachedImage('E:/img-64.png')).toBeTruthy()
  })
})

describe('LocalImageError', () => {
  it('带 code，方便界面按类型给文案', () => {
    const error = new LocalImageError('too-large', '图片超过 32 MB')
    expect(error.code).toBe('too-large')
    expect(error.name).toBe('LocalImageError')
  })
})
