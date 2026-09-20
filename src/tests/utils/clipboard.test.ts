/**
 * utils/clipboard —— 剪贴板 / 另存为公共工具
 *
 * 重点覆盖三条容易错的链路：
 *   1. 图片字节的来源（dataURL 本地解码 / 远端走 plugin-http 绕 CORS）；
 *   2. 「复制图片」的原生优先 + 浏览器兜底（原生失败必须真的退到 ClipboardItem）；
 *   3. 「另存为」的写出内容与「用户取消不算失败」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { fetch as httpFetch } from '@tauri-apps/plugin-http'
import {
  copyImageToClipboard,
  copyText,
  defaultImageName,
  imageExtOf,
  imageMimeOf,
  readImageBytes,
  saveImageAs,
} from '@/utils/clipboard'

/** base64('AAEC') = 0x00 0x01 0x02 */
const DATA_URL = 'data:image/png;base64,AAEC'

describe('图片字节来源', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(httpFetch).mockReset()
  })

  it('dataURL：本地 base64 解码，不发任何网络请求', async () => {
    const bytes = await readImageBytes(DATA_URL)
    expect(Array.from(bytes)).toEqual([0, 1, 2])
    expect(httpFetch).not.toHaveBeenCalled()
  })

  it('远端：走 plugin-http（WebView 内直接 fetch 会被 CORS 拦）', async () => {
    vi.mocked(httpFetch).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
    } as any)

    const bytes = await readImageBytes('https://example.com/a.png')
    expect(httpFetch).toHaveBeenCalledWith('https://example.com/a.png')
    expect(Array.from(bytes)).toEqual([9, 8, 7])
  })

  it('远端非 2xx：抛错（由调用方提示「复制失败」）', async () => {
    vi.mocked(httpFetch).mockResolvedValue({ ok: false, status: 404 } as any)
    await expect(readImageBytes('https://example.com/missing.png')).rejects.toThrow(
      'HTTP 404',
    )
  })

  it('MIME / 扩展名 / 默认文件名', () => {
    expect(imageMimeOf(DATA_URL)).toBe('image/png')
    expect(imageMimeOf('https://a/b.jpeg')).toBe('image/jpeg')
    expect(imageExtOf('https://a/b.webp?x=1')).toBe('webp')
    expect(imageExtOf(DATA_URL)).toBe('png')
    expect(imageExtOf('https://a/b.gif')).toBe('gif')
    expect(defaultImageName('image')).toMatch(/^image-\d{8}-\d{6}$/)
  })
})

describe('copyText', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
  })

  it('走 navigator.clipboard', async () => {
    expect(await copyText('hello')).toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
  })

  it('空文本直接返回 false（不写空内容进剪贴板）', async () => {
    expect(await copyText('')).toBe(false)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('clipboard 抛错 → 退 execCommand 兜底', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    document.execCommand = vi.fn(() => true)
    expect(await copyText('fallback')).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })
})

describe('copyImageToClipboard', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    delete (globalThis as any).ClipboardItem
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
  })

  it('原生可用时走 write_clipboard_image（只传 base64，格式由 Rust 判定）', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    expect(await copyImageToClipboard(DATA_URL)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('write_clipboard_image', {
      base64: 'AAEC',
    })
    expect(navigator.clipboard.write).not.toHaveBeenCalled()
  })

  it('原生失败（非 Windows / 未实现）→ 退浏览器 ClipboardItem', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('暂未实现'))
    ;(globalThis as any).ClipboardItem = class {
      constructor(public data: Record<string, Blob>) {}
    }
    expect(await copyImageToClipboard(DATA_URL)).toBe(true)
    expect(navigator.clipboard.write).toHaveBeenCalled()
  })

  it('两条路都失败 → 返回 false（调用方提示「复制失败」）', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('暂未实现'))
    // 不定义 ClipboardItem → 浏览器兜底也不可用
    expect(await copyImageToClipboard(DATA_URL)).toBe(false)
  })
})

describe('saveImageAs', () => {
  beforeEach(() => {
    vi.mocked(save).mockReset()
    vi.mocked(writeFile).mockReset()
  })

  it('写入用户选定路径，按 MIME 补上扩展名', async () => {
    vi.mocked(save).mockResolvedValue('E:/tmp/a.png' as any)
    const path = await saveImageAs(DATA_URL, 'image-1')

    expect(path).toBe('E:/tmp/a.png')
    // 对话框预填名带扩展名（这里给的是不带扩展名的前缀）
    expect(vi.mocked(save).mock.calls[0][0]).toMatchObject({
      defaultPath: 'image-1.png',
    })
    const [writtenPath, data] = vi.mocked(writeFile).mock.calls[0]
    expect(writtenPath).toBe('E:/tmp/a.png')
    expect(Array.from(data as Uint8Array)).toEqual([0, 1, 2])
  })

  it('用户取消 → 返回空串，不写盘（不算失败）', async () => {
    vi.mocked(save).mockResolvedValue(null as any)
    expect(await saveImageAs(DATA_URL, 'image-2')).toBe('')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
