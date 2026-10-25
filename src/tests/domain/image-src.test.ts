// @vitest-environment node
/**
 * Markdown 图片地址的分类与归一化。
 *
 * 这条纯函数决定「谁去加载」：判错一边就等于图片不显示（或者把本地路径当 URL 请求出去）。
 * 所以几种真实出现过的写法都钉一遍：盘符、反斜杠、file://、UNC、百分号编码。
 */
import { describe, expect, it } from 'vitest'
import { fileUrlToPath, parseImageSrc } from '@/domain/files/image-src'

describe('parseImageSrc', () => {
  it('远程 / data / blob / 协议相对 → 交给 <img> 直接加载', () => {
    for (const src of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/abc',
      '//cdn.example.com/a.png',
    ]) {
      const parsed = parseImageSrc(src)
      expect(parsed.kind, src).toBe('inline')
      expect(parsed.value, src).toBe(src)
    }
  })

  it('相对工作目录的路径 → 本地读取（含 ./ 与裸文件名）', () => {
    for (const src of ['./shots/a.png', 'shots/a.png', 'a.png', '../a.png']) {
      expect(parseImageSrc(src)).toMatchObject({ kind: 'local', value: src })
    }
  })

  it('Windows 绝对路径原样保留（两种分隔符都算）', () => {
    expect(parseImageSrc('C:\\code\\a.png').value).toBe('C:\\code\\a.png')
    expect(parseImageSrc('D:/work/a.png').value).toBe('D:/work/a.png')
    expect(parseImageSrc('c:a.png').kind).toBe('local')
  })

  it('POSIX 绝对路径也算本地（是否允许读由安全校验决定）', () => {
    expect(parseImageSrc('/home/me/a.png')).toMatchObject({
      kind: 'local',
      value: '/home/me/a.png',
    })
  })

  it('file:///C:/a.png → C:/a.png（去掉盘符前那个多余的斜杠）', () => {
    expect(parseImageSrc('file:///C:/code/a.png').value).toBe('C:/code/a.png')
  })

  it('file://server/share/a.png → UNC 路径（不能吃掉 //）', () => {
    expect(parseImageSrc('file://server/share/a.png').value).toBe('//server/share/a.png')
  })

  it('非标准的 file:/C:/a.png 与 file:C:/a.png 也要认', () => {
    expect(fileUrlToPath('file:/C:/a.png')).toBe('C:/a.png')
    expect(fileUrlToPath('file:C:/a.png')).toBe('C:/a.png')
    expect(fileUrlToPath('file:///home/me/a.png')).toBe('/home/me/a.png')
  })

  it('%20 这类编码要还原；不合法的百分号原样保留', () => {
    expect(parseImageSrc('./my%20shot.png').value).toBe('./my shot.png')
    expect(parseImageSrc('file:///C:/a%20b/c.png').value).toBe('C:/a b/c.png')
    // 路径里真的有 %（如 100%.png 里的 % png 不构成合法转义）
    expect(parseImageSrc('100%.png').value).toBe('100%.png')
  })

  it('空串仍是 local（由界面提示「地址为空」，而不是当成远程去加载）', () => {
    expect(parseImageSrc('   ')).toMatchObject({ kind: 'local', value: '', raw: '' })
  })

  it('raw 保留原写法，供失败提示回显', () => {
    expect(parseImageSrc('  ./a.png  ').raw).toBe('./a.png')
  })
})
