// @vitest-environment node
/**
 * 文件「打开方式」的判定口径（双击打开与右侧面板共用）。
 *
 * 重点在两类边界：
 * - **没有扩展名的文本**（LICENSE / Makefile / .gitignore）不能被白名单挡在外面；
 * - **已知二进制容器**（zip / odt / 可执行文件）不能当文本读（读进来是乱码或几 MB 噪声），
 *   而 pdf / Office 六种要走自己的预览通道（`pdf` / `document` / `sheet`），不能落回 `other`。
 */
import { describe, expect, it } from 'vitest'
import {
  extensionOf,
  mimeOf,
  MODEL_EXTENSIONS,
  monacoLanguageOf,
  previewKindOf,
  relativeDirOf,
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
    expect(previewKindOf('a.exe')).toBe('other')
    expect(previewKindOf('a.tar.gz')).toBe('other')
    // 仍然不支持预览的 Office 容器（`doc_parse` 不支持：`odt/ods/odp`）
    expect(previewKindOf('a.odt')).toBe('other')
  })

  it('PDF / 文稿 / 表格各有自己的预览通道', () => {
    // PDF：前端 pdfjs 按页栅格化
    expect(previewKindOf('a.pdf')).toBe('pdf')
    expect(previewKindOf('A.PDF')).toBe('pdf')
    // 文稿 / 演示：Rust 抽成 Markdown
    for (const name of ['a.docx', 'a.doc', 'a.pptx', 'a.ppt']) {
      expect(previewKindOf(name)).toBe('document')
    }
    // 表格：每张工作表一份网格
    for (const name of ['a.xlsx', 'a.xls']) {
      expect(previewKindOf(name)).toBe('sheet')
    }
    // CSV / TSV 仍是可编辑文本（预览在 `文本预览` 那一组）
    expect(previewKindOf('a.csv')).toBe('text')
  })

  it('3D 模型：13 种自有加载器的格式都进模型预览（含其实是文本的 obj / stl / dae）', () => {
    for (const name of [
      'a.glb',
      'a.gltf',
      'a.fbx',
      'a.obj',
      'a.stl',
      'a.ply',
      'a.dae',
      'a.3ds',
      'a.3mf',
      'a.amf',
      'a.wrl',
      'a.vrml',
      'a.pcd',
    ]) {
      expect(previewKindOf(name)).toBe('model')
    }
    expect(previewKindOf('SCENE.GLB')).toBe('model')
    // 与判定表同一份：导出给加载器注册表做穷尽检查
    expect(MODEL_EXTENSIONS).toHaveLength(13)
  })

  it('pdb 仍归「其它」：它同时是 MSVC 程序数据库，不能当蛋白质结构解析', () => {
    expect(previewKindOf('a.pdb')).toBe('other')
    expect(MODEL_EXTENSIONS).not.toContain('pdb')
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

  it('csv / tsv 多一个表格预览（文件仍可编辑）', () => {
    expect(textPreviewKindOf('a.csv')).toBe('csv')
    expect(textPreviewKindOf('a.CSV')).toBe('csv')
    expect(textPreviewKindOf('a.tsv')).toBe('tsv')
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

/**
 * HTML 预览的基址要靠它补上「文件所在的子目录」：页面里的 `./app.css` 相对的是文件目录，
 * 而协议登记的是工作区根 —— 漏了这段，子目录里的页面所有相对资源都 404。
 */
describe('相对工作区根的子目录', () => {
  it('根目录下的文件没有子目录', () => {
    expect(relativeDirOf('E:/repo/page.html', 'E:/repo')).toBe('')
    expect(relativeDirOf('E:/repo/page.html', 'E:/repo/')).toBe('')
  })

  it('多级子目录按 POSIX 风格拼', () => {
    expect(relativeDirOf('E:/repo/docs/demo/index.html', 'E:/repo')).toBe('docs/demo')
    expect(relativeDirOf('E:\\repo\\docs\\demo\\index.html', 'E:/repo')).toBe('docs/demo')
  })

  it('大小写 / 末尾斜杠不影响判定', () => {
    expect(relativeDirOf('e:/REPO/Docs/a.html', 'E:/repo')).toBe('Docs')
    expect(relativeDirOf('E:/repo/a/b/c.html', 'E:\\repo\\')).toBe('a/b')
  })

  it('不在根内或与根同层时回空串（宁可不注入子目录）', () => {
    expect(relativeDirOf('E:/other/docs/a.html', 'E:/repo')).toBe('')
    expect(relativeDirOf('E:/repo', 'E:/repo')).toBe('')
  })
})
