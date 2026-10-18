/**
 * 文件「打开方式」的判定口径（双击打开与右侧面板共用）。
 *
 * 重点在两类边界：
 * - **没有扩展名的文本**（LICENSE / Makefile / .gitignore）不能被白名单挡在外面；
 * - **已知二进制容器**（zip / pdf / office / 可执行文件）不能当文本读（读进来是乱码或几 MB 噪声）。
 */
import { describe, expect, it } from 'vitest'
import {
  extensionOf,
  mimeOf,
  monacoLanguageOf,
  previewKindOf,
  textPreviewKindOf,
} from '@/domain/files/preview'

describe('扩展名', () => {
  it('取最后一段（a.tar.gz 是 gz）', () => {
    expect(extensionOf('notes.md')).toBe('md')
    expect(extensionOf('a.tar.gz')).toBe('gz')
    expect(extensionOf('/repo/src/App.tsx')).toBe('tsx')
  })

  it('点开头的文件名不算扩展名', () => {
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('LICENSE')).toBe('')
    expect(extensionOf('C:\\repo\\README')).toBe('')
  })
})

describe('打开方式', () => {
  it('图片 / 音频 / 视频各自归类', () => {
    expect(previewKindOf('a.png')).toBe('image')
    expect(previewKindOf('a.JPEG')).toBe('image')
    expect(previewKindOf('a.webp')).toBe('image')
    expect(previewKindOf('a.mp3')).toBe('audio')
    expect(previewKindOf('a.flac')).toBe('audio')
    expect(previewKindOf('a.mp4')).toBe('video')
    expect(previewKindOf('a.webm')).toBe('video')
  })

  it('无扩展名与未知扩展名都按文本试读', () => {
    expect(previewKindOf('LICENSE')).toBe('text')
    expect(previewKindOf('Makefile')).toBe('text')
    expect(previewKindOf('.gitignore')).toBe('text')
    expect(previewKindOf('notes.unknownext')).toBe('text')
    // SVG 是 XML 文本，进编辑器而不是当图片
    expect(previewKindOf('icon.svg')).toBe('text')
  })

  it('已知二进制容器不进编辑器', () => {
    expect(previewKindOf('a.zip')).toBe('other')
    expect(previewKindOf('a.pdf')).toBe('other')
    expect(previewKindOf('a.docx')).toBe('other')
    expect(previewKindOf('a.exe')).toBe('other')
    expect(previewKindOf('a.tar.gz')).toBe('other')
  })
})

describe('文本预览（编辑 / 预览两个模式）', () => {
  it('markdown / html / svg 有预览', () => {
    expect(textPreviewKindOf('README.md')).toBe('markdown')
    expect(textPreviewKindOf('a.markdown')).toBe('markdown')
    expect(textPreviewKindOf('index.html')).toBe('html')
    expect(textPreviewKindOf('a.xhtml')).toBe('html')
    expect(textPreviewKindOf('icon.svg')).toBe('svg')
  })

  it('其余文本只有编辑', () => {
    expect(textPreviewKindOf('a.ts')).toBeNull()
    expect(textPreviewKindOf('a.json')).toBeNull()
    expect(textPreviewKindOf('LICENSE')).toBeNull()
  })
})

describe('媒体类型', () => {
  it('认识常见格式', () => {
    expect(mimeOf('a.png')).toBe('image/png')
    expect(mimeOf('a.m4a')).toBe('audio/mp4')
    expect(mimeOf('a.mkv')).toBe('video/x-matroska')
    expect(mimeOf('a.unknown')).toBe('application/octet-stream')
  })
})

describe('Monaco 语言', () => {
  it('按扩展名映射到已注册的高亮', () => {
    expect(monacoLanguageOf('App.tsx')).toBe('typescript')
    expect(monacoLanguageOf('main.rs')).toBe('rust')
    expect(monacoLanguageOf('Cargo.toml')).toBe('ini')
    expect(monacoLanguageOf('a.json')).toBe('json')
    expect(monacoLanguageOf('a.scss')).toBe('scss')
  })

  it('特殊文件名与未知类型', () => {
    expect(monacoLanguageOf('Dockerfile')).toBe('dockerfile')
    expect(monacoLanguageOf('LICENSE')).toBe('plaintext')
  })
})
