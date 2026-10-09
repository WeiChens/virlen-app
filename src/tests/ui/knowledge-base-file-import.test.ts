/**
 * 知识库文件导入：同名冲突策略 + 二进制拦截 + 报账文案
 *
 * 守的四件事：
 * 1. **同名文档不能默默变成两份**（选「覆盖」走替换、「跳过」保留原文档）；
 * 2. **二进制文件不能被当文本读进来** —— `iso-8859-1` / `windows-1252` 对任何字节都能
 *    解码成功、永不报错，没有内容嗅探的话「读不出来」那条分支实际不可达（PDF 被读成乱码
 *    填进编辑框就是这么来的）；
 * 3. 导入结果要**拆开报账**（新增 / 覆盖 / 跳过 / 失败分开说）；
 * 4. **不再按扩展名筛**：PDF 交给后端解析，其余文件（含 `.json` / 无扩展名）当纯文本试读，
 *    单份文本超过 2 MB、PDF 超过 50 MB 先挡住（而不是先整个读进内存才发现）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockListDocuments = vi.fn()
const mockWriteText = vi.fn()
const mockEditTextDocument = vi.fn()
const mockAddDocument = vi.fn()
const mockEditDocument = vi.fn()

vi.mock('@/services/rag-service', () => ({
  ragService: {
    listDocuments: (...a: any[]) => mockListDocuments(...a),
    writeText: (...a: any[]) => mockWriteText(...a),
    editTextDocument: (...a: any[]) => mockEditTextDocument(...a),
    addDocument: (...a: any[]) => mockAddDocument(...a),
    editDocument: (...a: any[]) => mockEditDocument(...a),
  },
}))
vi.mock('@/ui/components/shared/Toast', () => ({ showToast: vi.fn() }))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: vi.fn(() => Promise.resolve(true)) },
}))

const mockReadTextFile = vi.fn()
const mockReadFile = vi.fn()
const mockStat = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (...a: any[]) => mockReadTextFile(...a),
  readFile: (...a: any[]) => mockReadFile(...a),
  stat: (...a: any[]) => mockStat(...a),
}))

import {
  looksLikeText,
  summarizeImport,
  tryDecodeTextFile,
  uploadFiles,
} from '@/ui/pages/Settings/knowledge-base/file-import'
import { showToast } from '@/ui/components/shared/Toast'

beforeEach(() => {
  vi.clearAllMocks()
  // 默认：文件很小（大小相关的用例自己改这个 mock）
  mockStat.mockResolvedValue({ size: 1024 })
})

describe('looksLikeText（二进制拦截）', () => {
  it('正常文本 / 中文 / 换行都算文本', () => {
    expect(looksLikeText('普通文本')).toBe(true)
    expect(looksLikeText('line1\nline2\tend')).toBe(true)
  })

  it('含 NUL 就不是文本（PDF / UTF-16 / 压缩包都带 NUL）', () => {
    expect(looksLikeText('abc\u0000def')).toBe(false)
  })

  it('大片控制字符 / 替换字符不是文本', () => {
    expect(looksLikeText('\u0001\u0002\u0003\u0004\u0005\u0006')).toBe(false)
    expect(looksLikeText('\ufffd'.repeat(20))).toBe(false)
  })

  it('空串不算文本（没内容可入库）', () => {
    expect(looksLikeText('')).toBe(false)
  })
})

describe('tryDecodeTextFile', () => {
  it('UTF-8 正常文本：直接返回 UTF-8', async () => {
    mockReadTextFile.mockResolvedValue('一份正常文档')
    await expect(tryDecodeTextFile('C:/a.md')).resolves.toEqual({
      text: '一份正常文档',
      encoding: 'UTF-8',
    })
  })

  it('二进制文件：返回 null（而不是拿 latin1 解出一堆乱码）', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not utf-8'))
    // PDF 头 + NUL，latin1 / windows-1252 都能「解码成功」
    mockReadFile.mockResolvedValue(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xff, 0xfe]),
    )
    await expect(tryDecodeTextFile('C:/扫描件.pdf')).resolves.toBeNull()
  })

  it('GBK 文本：UTF-8 读不出来时能回退到兼容编码', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not utf-8'))
    // “中文” 的 GBK 编码
    mockReadFile.mockResolvedValue(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))
    const decoded = await tryDecodeTextFile('C:/gbk.txt')
    expect(decoded?.text).toBe('中文')
    expect(decoded?.encoding).toBe('GBK')
  })
})

describe('summarizeImport', () => {
  it('四种结局拆开报账，只说有数的那些', () => {
    expect(
      summarizeImport({ created: 2, overwritten: 1, skipped: 0, failed: 0 }),
    ).toBe('新增 2 份，覆盖 1 份')
    expect(
      summarizeImport({ created: 0, overwritten: 0, skipped: 3, failed: 1 }),
    ).toBe('跳过同名 3 份，1 份没成功')
  })

  it('什么都没发生 → 说「没有可导入的文件」', () => {
    expect(
      summarizeImport({ created: 0, overwritten: 0, skipped: 0, failed: 0 }),
    ).toBe('没有可导入的文件')
  })
})

describe('uploadFiles 的同名策略', () => {
  const file = 'C:/资料/笔记.md'

  beforeEach(() => {
    mockReadTextFile.mockResolvedValue('新内容')
  })

  it('覆盖：走 editTextDocument（文档名沿用原来那份），不再新增', async () => {
    mockEditTextDocument.mockResolvedValue({ id: 'doc1' })
    await uploadFiles(
      'kb1',
      [file],
      { existing: new Map([['笔记.md', 'doc1']]), overwrite: true },
    )
    expect(mockEditTextDocument).toHaveBeenCalledWith('kb1', 'doc1', '笔记.md', '新内容')
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(mockAddDocument).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('覆盖 1 份', 2500)
  })

  it('跳过：同名文档原样不动，并如实报「跳过同名」', async () => {
    await uploadFiles(
      'kb1',
      [file],
      { existing: new Map([['笔记.md', 'doc1']]), overwrite: false },
    )
    expect(mockEditTextDocument).not.toHaveBeenCalled()
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(mockAddDocument).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('跳过同名 1 份', 2500)
  })

  it('没有同名：读出来当纯文本写进库（writeText），不再交给后端解析', async () => {
    await uploadFiles('kb1', [file], { existing: new Map(), overwrite: false })
    expect(mockWriteText).toHaveBeenCalledWith('kb1', '笔记.md', '新内容')
    expect(mockAddDocument).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('新增 1 份', 2500)
  })

  it('不再看扩展名：.json / 无扩展名的纯文本一样读进来', async () => {
    await uploadFiles(
      'kb1',
      ['C:/资料/config.json', 'C:/资料/README'],
      { existing: new Map(), overwrite: false },
    )
    expect(mockWriteText).toHaveBeenNthCalledWith(1, 'kb1', 'config.json', '新内容')
    expect(mockWriteText).toHaveBeenNthCalledWith(2, 'kb1', 'README', '新内容')
    expect(showToast).toHaveBeenCalledWith('新增 2 份', 2500)
  })

  it('PDF：交给后端解析（addDocument），并把文档名一起传下去', async () => {
    mockAddDocument.mockResolvedValue({ id: 'doc_pdf' })
    await uploadFiles('kb1', ['C:/资料/手册.pdf'], {
      existing: new Map(),
      overwrite: false,
    })
    expect(mockAddDocument).toHaveBeenCalledWith('kb1', 'C:/资料/手册.pdf', '手册.pdf')
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(mockReadTextFile).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('新增 1 份', 2500)
  })

  it('纯文本超过 2 MB：不读、算失败，并说清是哪一份', async () => {
    mockStat.mockResolvedValue({ size: 2 * 1024 * 1024 + 1 })
    await uploadFiles('kb1', ['C:/资料/巨档.log'], {
      existing: new Map(),
      overwrite: false,
    })
    expect(mockReadTextFile).not.toHaveBeenCalled()
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      '「巨档.log」没能加进来：文件超过 2 MB',
      3000,
    )
  })

  it('PDF 超过 50 MB：同样先挡住（后端上限提前说出来）', async () => {
    mockStat.mockResolvedValue({ size: 50 * 1024 * 1024 + 1 })
    await uploadFiles('kb1', ['C:/资料/巨档.pdf'], {
      existing: new Map(),
      overwrite: false,
    })
    expect(mockAddDocument).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      '「巨档.pdf」没能加进来：文件超过 50 MB',
      3000,
    )
  })

  it('读不出文字的（二进制）：算失败并说清原因，不静默丢', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not utf-8'))
    mockReadFile.mockResolvedValue(new Uint8Array([0x00, 0x01, 0xff, 0xfe]))
    await uploadFiles('kb1', ['C:/资料/图.png'], {
      existing: new Map(),
      overwrite: false,
    })
    expect(mockWriteText).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      '跳过「图.png」：这个文件读不出文字（可能是二进制文件）',
      3000,
    )
  })

  it('GBK 文本：解码成功就入库，并在进度里说明用的什么编码', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not utf-8'))
    mockReadFile.mockResolvedValue(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))
    const steps: string[] = []
    const task = {
      cancelled: false,
      step: (_c: number, latest: string) => steps.push(latest),
      finish: vi.fn(),
    } as any
    await uploadFiles('kb1', ['C:/资料/gbk.txt'], { existing: new Map() }, undefined, task)
    expect(mockWriteText).toHaveBeenCalledWith('kb1', 'gbk.txt', '中文')
    expect(steps[0]).toBe('正在读入「gbk.txt」（GBK）…')
  })

  it('文件夹导入：文档名用相对路径（能覆盖同名的那一份）', async () => {
    mockEditTextDocument.mockResolvedValue({ id: 'doc_sub' })
    await uploadFiles(
      'kb1',
      ['C:/proj/docs/子目录/规范.md'],
      {
        baseDir: 'C:/proj/docs',
        existing: new Map([['子目录/规范.md', 'doc_sub']]),
        overwrite: true,
      },
    )
    expect(mockEditTextDocument).toHaveBeenCalledWith(
      'kb1',
      'doc_sub',
      '子目录/规范.md',
      '新内容',
    )
  })
})
