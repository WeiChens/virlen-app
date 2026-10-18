/**
 * HTML 预览文档组装：base 注入、脚本开关的 CSP、畸形 HTML 不抛。
 *
 * 这些断言守的是「安全默认值」：
 * - 脚本关闭时不注入 CSP（iframe 的 sandbox 已经禁脚本），开脚本时必须带 CSP；
 * - 页面自带的 `<base>` 一律被移除（否则它能把自己指到任意位置）；
 * - 无论输入多畸形，函数只返回字符串，不抛（预览失败不能影响外层面板）。
 */
import { describe, expect, it } from 'vitest'
import { buildPreviewDocument, previewNeeds } from '@/domain/files/html-preview'

const BASE = 'http://virlen-preview.localhost/550e8400-e29b-41d4-a716-446655440000/'

describe('base 注入', () => {
  it('注入我们的 base，并保留正文', () => {
    const doc = buildPreviewDocument('<h1>hi</h1>', BASE, false)
    expect(doc).toContain(`<base href="${BASE}">`)
    expect(doc).toContain('<h1>hi</h1>')
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('页面自带的 base 被移除（基址只能由我们给）', () => {
    const doc = buildPreviewDocument(
      '<html><head><base href="https://evil.example/"></head><body>x</body></html>',
      BASE,
      false,
    )
    expect(doc).not.toContain('evil.example')
    expect(doc).toContain(`<base href="${BASE}">`)
  })

  it('没有 base（登记失败）也能出文档，只是不注入', () => {
    const doc = buildPreviewDocument('<p>plain</p>', null, false)
    expect(doc).not.toContain('<base')
    expect(doc).toContain('<p>plain</p>')
  })

  it('畸形 HTML 不抛（未闭合标签照样能渲染）', () => {
    expect(() => buildPreviewDocument('<div><p>unclosed', BASE, false)).not.toThrow()
    expect(buildPreviewDocument('<div><p>unclosed', BASE, false)).toContain('unclosed')
  })
})

describe('previewNeeds（提示条的判据）', () => {
  it('没有脚本：两条都是 false', () => {
    expect(previewNeeds('<h1>hi</h1>')).toEqual({ hasScripts: false, hasRemoteScripts: false })
  })

  it('内联脚本 / importmap 也算「有脚本」', () => {
    expect(previewNeeds('<script>console.log(1)</script>').hasScripts).toBe(true)
    expect(
      previewNeeds('<script type="importmap">{"imports":{}}</script>').hasScripts,
    ).toBe(true)
  })

  it('https 外链脚本标记为需要外部资源（http 不算）', () => {
    expect(
      previewNeeds('<script src="https://cdn.example/a.js"></script>').hasRemoteScripts,
    ).toBe(true)
    expect(previewNeeds('<script src="./a.js"></script>').hasRemoteScripts).toBe(false)
    expect(previewNeeds('<script src="http://cdn.example/a.js"></script>').hasRemoteScripts).toBe(
      false,
    )
  })
})

describe('脚本开关与 CSP', () => {
  it('脚本关闭：不注入 CSP', () => {
    const doc = buildPreviewDocument('<p>x</p>', BASE, false)
    expect(doc).not.toContain('Content-Security-Policy')
  })

  it('脚本开启：注入严格 CSP，网络出口被关掉', () => {
    const doc = buildPreviewDocument('<p>x</p>', BASE, true)
    expect(doc).toContain('Content-Security-Policy')
    // 只允许本地资源源
    expect(doc).toContain('http://virlen-preview.localhost')
    // 外传通道：fetch / XHR / WebSocket / 子 frame / 表单
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain("frame-src 'none'")
    expect(doc).toContain("form-action 'none'")
    expect(doc).toContain(`base-uri http://virlen-preview.localhost`)
    expect(doc).toContain("default-src 'none'")
  })

  it('脚本开启但没有 base：CSP 不含本地源，base-uri 锁成 none', () => {
    const doc = buildPreviewDocument('<p>x</p>', null, true)
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain("base-uri 'none'")
    expect(doc).not.toContain('virlen-preview')
  })

  it('静态资源默认放行 https（与「脚本关闭时能加载外链图片」保持一致）', () => {
    const doc = buildPreviewDocument('<p>x</p>', BASE, true)
    expect(doc).toContain('img-src http://virlen-preview.localhost data: blob: https:')
  })

  it('外部脚本默认仍被挡：script-src 不含 https，只有内联与本目录', () => {
    const doc = buildPreviewDocument('<p>x</p>', BASE, true)
    const scriptSrc = /script-src ([^;]+)/.exec(doc)?.[1] ?? ''
    expect(scriptSrc).toContain("'unsafe-inline'")
    expect(scriptSrc).toContain('virlen-preview.localhost')
    expect(scriptSrc).not.toContain('https:')
    // fetch / XHR / WebSocket 也不放开
    expect(doc).toContain("connect-src 'none'")
  })

  it('允许外部资源：script-src 与 connect-src 都带上 https，worker 也放行', () => {
    const doc = buildPreviewDocument('<p>x</p>', BASE, true, true)
    const scriptSrc = /script-src ([^;]+)/.exec(doc)?.[1] ?? ''
    expect(scriptSrc).toContain('https:')
    expect(doc).toContain('connect-src https:')
    // CDN 上的 worker 脚本（three.js 的 decoder 之类）
    expect(doc).toContain('worker-src blob: https:')
    // 这几条在任何档位下都不放开
    expect(doc).toContain("frame-src 'none'")
    expect(doc).toContain("form-action 'none'")
  })

  it('非 Windows 的自定义 scheme 也能被 CSP 表达', () => {
    const doc = buildPreviewDocument(
      '<p>x</p>',
      'virlen-preview://localhost/550e8400-e29b-41d4-a716-446655440000/',
      true,
    )
    expect(doc).toContain('script-src \'unsafe-inline\' \'unsafe-eval\' virlen-preview://localhost')
  })
})
