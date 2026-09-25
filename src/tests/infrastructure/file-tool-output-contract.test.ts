/**
 * file 组工具「模型侧固定英文 + UI 侧结构化 uiData」契约测试（P4b-②）
 *
 * 背景同 `tool-output-contract.test.ts`：`content` 是「模型 + UI」双用途字段。
 * file 组在 P3 中只改了 Rust 侧文案，导致中文界面下的默认（Rust）引擎把英文
 * 结果直接渲染到展开视图（回归）。本批把 **TS 执行器** 也固定为英文，
 * 并补齐语言无关的结构化 `uiData`，由组件按界面语言渲染。
 *
 * 这里钉住两条：
 *   1. 执行器产出与 UI 语言无关（当前 UI 语言为中文时仍是英文）；
 *   2. `uiData` 形状（供组件与 Rust 原生实现共同遵守）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutorResponse } from '@/domain/tools/types'

// Mock 安全服务：resolveSafePath 直接返回输入路径，避免依赖真实工作区逻辑
vi.mock('@/services/security-service', () => ({
  securityService: {
    resolveSafePath: vi.fn(async (p: string) => p),
    getSkipEachDirs: vi.fn(async () => []),
  },
}))

// 引入文件工具模块（触发各工具注册）
import '@/infrastructure/tools/file'

const CJK = /[\u4e00-\u9fff]/

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

function pick(result: ToolExecutorResponse): { content: string; uiData: any } {
  if (typeof result === 'string') return { content: result, uiData: undefined }
  if ('content' in result)
    return { content: result.content, uiData: (result as any).uiData }
  return { content: JSON.stringify(result), uiData: undefined }
}

async function run(
  name: string,
  args: any,
): Promise<{ content: string; uiData: any }> {
  const tool = await toolRegistry.get(name)
  expect(tool, `${name} 应已注册`).toBeDefined()
  return pick(await tool!.executor(args, makeCtx()))
}

describe('list_files：模型侧英文树 + uiData.nodes（语言无关目录树）', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue([
      { name: 'src', type: 'enter_dir' },
      { name: 'a.ts', type: 'file', size: 2048 },
      { name: 'b.ts', type: 'file', size: 10 },
      { name: 'sub', type: 'enter_dir' },
      { name: 'c.ts', type: 'file', size: 5 },
      { name: 'sub', type: 'leave_dir' },
      { name: 'src', type: 'leave_dir' },
    ])
  })

  it('content 为英文摘要，uiData 给出嵌套树 + 统计', async () => {
    const r = await run('list_files', { path: '/mock/root', recursive: true })

    expect(r.content).toContain('item(s) total')
    expect(r.content).not.toMatch(CJK)

    expect(r.uiData.rootPath).toBe('/mock/root')
    expect(r.uiData.totalItems).toBe(5)
    expect(r.uiData.maxItems).toBe(600)
    expect(r.uiData.truncated).toBe(false)

    expect(r.uiData.nodes).toHaveLength(1)
    expect(r.uiData.nodes[0]).toMatchObject({ name: 'src', isDir: true })
    expect(r.uiData.nodes[0].children).toHaveLength(3)
    expect(r.uiData.nodes[0].children[0]).toMatchObject({
      name: 'a.ts',
      isDir: false,
      size: 2048,
    })
  })

  it('空目录 → 英文 content + 空树（组件据此本地化展示）', async () => {
    vi.mocked(invoke).mockResolvedValue([])
    const r = await run('list_files', { path: '/mock/empty' })

    expect(r.content).toBe('(empty directory)')
    expect(r.content).not.toMatch(CJK)
    expect(r.uiData.nodes).toEqual([])
    expect(r.uiData.totalItems).toBe(0)
  })
})

describe('mkdir：模型侧英文 + uiData{created,existed,errors}', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false)
    vi.mocked(tauriFs.mkdir).mockResolvedValue(undefined as any)
  })

  it('创建成功 → content 英文 + uiData.created', async () => {
    const r = await run('mkdir', { path: '/mock/new-dir' })

    expect(r.content).toContain('Directory created')
    expect(r.content).not.toMatch(CJK)
    expect(r.uiData.created).toEqual(['/mock/new-dir'])
    expect(r.uiData.existed).toEqual([])
    expect(r.uiData.errors).toEqual([])
  })

  it('目录已存在 → 计入 existed（幂等语义不变）', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true)
    const r = await run('mkdir', { path: '/mock/exists-dir' })

    expect(r.content).toContain('Directory already exists')
    expect(r.content).not.toMatch(CJK)
    expect(r.uiData.existed).toEqual(['/mock/exists-dir'])
  })
})

describe('file_info：模型侧英文 + uiData 元信息（时间戳语言无关）', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true)
    vi.mocked(tauriFs.stat).mockResolvedValue({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: 1536,
      atime: new Date(1_700_000_000_000),
      mtime: new Date(1_700_000_000_000),
      birthtime: null,
      readonly: false,
    } as any)
  })

  it('返回英文文本 + atimeMs/mtimeMs', async () => {
    const r = await run('file_info', { path: '/mock/a.txt' })

    expect(r.content).toContain('Type: 📄 File')
    expect(r.content).toContain('Size: 1.5 KB')
    expect(r.content).not.toMatch(CJK)

    expect(r.uiData.path).toBe('/mock/a.txt')
    expect(r.uiData.isDirectory).toBe(false)
    expect(r.uiData.sizeBytes).toBe(1536)
    expect(r.uiData.atimeMs).toBe(1_700_000_000_000)
    expect(r.uiData.mtimeMs).toBe(1_700_000_000_000)
  })

  it('路径不存在 → 英文提示（与 Rust 侧逐字一致）', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(false)
    const r = await run('file_info', { path: '/mock/missing.txt' })

    expect(r.content).toBe('Error: path does not exist — /mock/missing.txt')
    expect(r.content).not.toMatch(CJK)
  })
})

describe('delete_file：模型侧英文 + uiData{deleted,errors}', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true)
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('移入回收站成功 → content 英文 + uiData.deleted', async () => {
    const r = await run('delete_file', { path: '/mock/gone.txt' })

    expect(r.content).toContain('Moved to trash')
    expect(r.content).not.toMatch(CJK)
    expect(r.uiData.deleted).toEqual(['/mock/gone.txt'])
    expect(r.uiData.errors).toEqual([])
  })

  it('未提供路径 → 英文提示（与 Rust 侧逐字一致）', async () => {
    const r = await run('delete_file', {})
    expect(r.content).toBe(
      'Error: no path to delete was provided (use a "paths" array, or a single "path" string)',
    )
    expect(r.content).not.toMatch(CJK)
  })
})
