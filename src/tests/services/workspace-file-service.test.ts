/**
 * 工作目录文件面板的数据层：读取分类、上限、hash 冲突检测。
 *
 * 全部走 mock（不碰真实文件系统）：真实 git / 磁盘语义由各自模块的用例守；
 * 这里要钉的是「哪种文件怎么读」「什么时候拒」「保存前有没有比对 hash」这三类判断。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, readFileMock, writeTextFileMock, resolveSafePathMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    readFileMock: vi.fn(),
    writeTextFileMock: vi.fn(),
    resolveSafePathMock: vi.fn(),
  }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: readFileMock,
  writeTextFile: writeTextFileMock,
}))
vi.mock('@/services/security-service', () => ({
  securityService: { resolveSafePath: resolveSafePathMock },
}))

import {
  loadWorkspaceFile,
  MAX_MEDIA_BYTES,
  MAX_TEXT_BYTES,
  saveWorkspaceText,
  WorkspaceFileError,
} from '@/services/workspace-file-service'

/** 装一个「路径存在、给定大小」的 stat */
function statSize(size: number) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'stat_path') {
      return Promise.resolve({ exists: true, is_file: true, size })
    }
    throw new Error(`unexpected invoke: ${cmd}`)
  })
}

function textRead(content: string, hash10 = 'abcdef0123') {
  return {
    content,
    hash10,
    line_count: content.split('\n').length,
    byte_size: content.length,
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  readFileMock.mockReset()
  writeTextFileMock.mockReset()
  resolveSafePathMock.mockReset()
  // 原样返回：用例要验的正是「哪种路径怎么读」，不能让 mock 把扩展名换掉
  resolveSafePathMock.mockImplementation((path: string) => Promise.resolve(path))
})

describe('读取', () => {
  it('文本：先 stat 再经 Rust 读（带编码嗅探），并把路径交给安全校验', async () => {
    statSize(12)
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'stat_path') {
        return Promise.resolve({ exists: true, is_file: true, size: 12 })
      }
      if (cmd === 'read_file_with_hash') return Promise.resolve(textRead('hello'))
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const file = await loadWorkspaceFile('E:/repo/a.txt', 's1')

    expect(resolveSafePathMock).toHaveBeenCalledWith('E:/repo/a.txt', 'r', 's1')
    expect(file).toEqual({
      kind: 'text',
      content: 'hello',
      hash10: 'abcdef0123',
      byteSize: 5,
      lineCount: 1,
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('文本超过上限：直接拒，不把文件读进来', async () => {
    statSize(MAX_TEXT_BYTES + 1)

    await expect(loadWorkspaceFile('E:/repo/a.txt')).rejects.toMatchObject({
      code: 'too-large',
    })
    expect(invokeMock).not.toHaveBeenCalledWith(
      'read_file_with_hash',
      expect.anything(),
    )
  })

  it('Rust 拒读（二进制 / 未知编码）→ binary，而不是笼统的「打不开」', async () => {
    statSize(10)
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'stat_path') {
        return Promise.resolve({ exists: true, is_file: true, size: 10 })
      }
      return Promise.reject('❌ Binary file detected')
    })

    await expect(loadWorkspaceFile('E:/repo/a.txt')).rejects.toMatchObject({
      code: 'binary',
    })
  })

  it('已知二进制容器：不读内容，只回大小', async () => {
    statSize(2048)
    const file = await loadWorkspaceFile('E:/repo/a.zip')
    expect(file).toEqual({ kind: 'other', byteSize: 2048 })
  })

  it('媒体：按字节读回，mime 由扩展名给', async () => {
    statSize(3)
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]))

    const file = await loadWorkspaceFile('E:/repo/pic.png')

    expect(readFileMock).toHaveBeenCalledWith('E:/repo/pic.png')
    expect(file).toMatchObject({ kind: 'image', mime: 'image/png', byteSize: 3 })
  })

  it('媒体超过上限：拒', async () => {
    statSize(MAX_MEDIA_BYTES + 1)
    await expect(loadWorkspaceFile('E:/repo/movie.mp4')).rejects.toMatchObject({
      code: 'too-large',
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('文件不存在 / 不是文件：分开报', async () => {
    invokeMock.mockResolvedValueOnce(null)
    await expect(loadWorkspaceFile('E:/repo/gone.txt')).rejects.toMatchObject({
      code: 'not-found',
    })

    invokeMock.mockResolvedValueOnce({ exists: true, is_file: false, size: 0 })
    await expect(loadWorkspaceFile('E:/repo/dir')).rejects.toMatchObject({
      code: 'not-file',
    })
  })
})

describe('保存', () => {
  it('磁盘内容没变：写入并回新 hash', async () => {
    invokeMock.mockResolvedValue(textRead('old', 'base123456'))
    writeTextFileMock.mockResolvedValue(undefined)

    const result = await saveWorkspaceText('E:/repo/a.txt', 'new', 'base123456', 's1')

    expect(resolveSafePathMock).toHaveBeenCalledWith('E:/repo/a.txt', 'w', 's1')
    expect(writeTextFileMock).toHaveBeenCalledWith('E:/repo/a.txt', 'new')
    expect(result.hash10).toHaveLength(10)
    expect(result.lineCount).toBe(1)
    expect(result.byteSize).toBe(3)
  })

  it('行数与 Rust lines() 同口径：尾部换行不多算一行', async () => {
    invokeMock.mockResolvedValue(textRead('a\nb\n', 'base123456'))
    writeTextFileMock.mockResolvedValue(undefined)

    const result = await saveWorkspaceText('E:/repo/a.txt', 'a\nb\n', 'base123456')

    // Rust 的 `"a\nb\n".lines().count()` = 2；`split('\n')` 会给出 3（尾部空段）
    expect(result.lineCount).toBe(2)
  })

  it('磁盘内容被改过：报冲突且**不写盘**', async () => {
    invokeMock.mockResolvedValue(textRead('changed by someone', 'other12345'))

    await expect(
      saveWorkspaceText('E:/repo/a.txt', 'new', 'base123456'),
    ).rejects.toBeInstanceOf(WorkspaceFileError)
    expect(writeTextFileMock).not.toHaveBeenCalled()
  })

  it('文件读不到（被删 / 被锁）：同样按冲突处理，不盖写', async () => {
    invokeMock.mockRejectedValue('not found')
    await expect(
      saveWorkspaceText('E:/repo/a.txt', 'new', 'base123456'),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(writeTextFileMock).not.toHaveBeenCalled()
  })
})
