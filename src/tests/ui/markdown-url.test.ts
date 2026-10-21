/**
 * Markdown 图片 URL 的放行规则。
 *
 * 这条规则不写就是「图片不显示」——react-markdown 默认把 `C:/a.png`、`file:///…`、`data:…`
 * 全都清成空串（它按 URL 语法判协议，盘符 `C:` 也算 scheme，而白名单只放 http 等几种）。
 * 同时要守住：只放行 `src`，`<a href>` 不能被顺手放开。
 */
import { describe, expect, it } from 'vitest'
import { defaultUrlTransform } from 'react-markdown'
import { allowImageSrc } from '@/ui/pages/chat/components/message/markdown-url'

describe('allowImageSrc', () => {
  it('图片 src：盘符 / file: / data: / 相对路径一律原样放行', () => {
    for (const src of [
      'C:/code/a.png',
      'C:\\code\\a.png',
      'file:///C:/code/a.png',
      'data:image/png;base64,AAAA',
      './shots/a.png',
      'a.png',
      'https://example.com/a.png',
    ]) {
      expect(allowImageSrc(src, 'src'), src).toBe(src)
    }
  })

  it('对照：默认规则确实会把这些清空（说明为什么必须自定义）', () => {
    expect(defaultUrlTransform('C:/code/a.png')).toBe('')
    expect(defaultUrlTransform('file:///C:/code/a.png')).toBe('')
    expect(defaultUrlTransform('data:image/png;base64,AAAA')).toBe('')
  })

  it('链接 href 仍走默认清洗：javascript: / file: 被清空，https 与相对路径保留', () => {
    expect(allowImageSrc('javascript:alert(1)', 'href')).toBe('')
    expect(allowImageSrc('file:///C:/a.html', 'href')).toBe('')
    expect(allowImageSrc('https://example.com/a', 'href')).toBe(
      'https://example.com/a',
    )
    expect(allowImageSrc('./docs/a.md', 'href')).toBe('./docs/a.md')
  })
})
