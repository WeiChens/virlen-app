/**
 * 图片附件引用（`attachment://`）的前端解析：库里的引用必须翻译成自定义协议 URL 才能渲染。
 * 与 Rust `virlen_core::attachment` / `commands/attachment.rs` 是同一套形状校验。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  ATTACHMENT_PREFIX,
  attachmentName,
  attachmentProtocolUrl,
  imageDisplaySrc,
  isAttachmentRef,
} from '@/domain/files/attachment-src'
import { parseImageSrc } from '@/domain/files/image-src'

const HASH = 'a'.repeat(64)

afterEach(() => {
  vi.unstubAllGlobals()
})

function withUserAgent(userAgent: string) {
  vi.stubGlobal('navigator', { userAgent })
}

describe('attachmentName / isAttachmentRef', () => {
  it('只认 64 位小写 hex + 已知图片扩展名', () => {
    expect(attachmentName(`${ATTACHMENT_PREFIX}${HASH}.png`)).toBe(`${HASH}.png`)
    expect(isAttachmentRef(`${ATTACHMENT_PREFIX}${HASH}.webp`)).toBe(true)
    // 大写 hex / 错误扩展名 / 缺前缀 都不算
    expect(isAttachmentRef(`${ATTACHMENT_PREFIX}${HASH.toUpperCase()}.png`)).toBe(false)
    expect(isAttachmentRef(`${ATTACHMENT_PREFIX}${HASH}.exe`)).toBe(false)
    expect(isAttachmentRef(`${HASH}.png`)).toBe(false)
    // 路径穿越不可能通过
    expect(isAttachmentRef(`${ATTACHMENT_PREFIX}../${HASH}.png`)).toBe(false)
    expect(attachmentName('data:image/png;base64,AAAA')).toBe('')
  })
})

describe('attachmentProtocolUrl', () => {
  it('Windows / Android 用 http://<scheme>.localhost/', () => {
    withUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(attachmentProtocolUrl(`${HASH}.png`)).toBe(
      `http://virlen-attachment.localhost/${HASH}.png`,
    )
  })

  it('其它平台用 <scheme>://localhost/', () => {
    withUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(attachmentProtocolUrl(`${HASH}.png`)).toBe(
      `virlen-attachment://localhost/${HASH}.png`,
    )
  })
})

describe('imageDisplaySrc', () => {
  it('只翻译附件引用，其余原样返回', () => {
    withUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const ref = `${ATTACHMENT_PREFIX}${HASH}.jpg`
    expect(imageDisplaySrc(ref)).toBe(`http://virlen-attachment.localhost/${HASH}.jpg`)

    for (const raw of [
      'data:image/png;base64,AAAA',
      'https://example.com/a.png',
      'blob:https://x/y',
      'C:\\shots\\a.png',
      './shots/a.png',
      '',
    ]) {
      expect(imageDisplaySrc(raw)).toBe(raw)
    }
  })
})

describe('parseImageSrc', () => {
  it('附件引用走 inline（交给浏览器加载），不走本地读盘', () => {
    withUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const ref = `${ATTACHMENT_PREFIX}${HASH}.png`
    expect(parseImageSrc(ref)).toEqual({
      kind: 'inline',
      value: `http://virlen-attachment.localhost/${HASH}.png`,
      raw: ref,
    })
  })

  it('形状不对的 attachment 前缀仍按本地路径处理（保持旧行为）', () => {
    const parsed = parseImageSrc('attachment://not-a-hash.png')
    expect(parsed.kind).toBe('local')
  })
})
