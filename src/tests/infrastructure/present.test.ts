/**
 * present 工具（JS 回退路径）— 交付物语义
 *
 * 四条：
 *   ① 存在的文件进 `uiData.files`（前端据此在右侧面板打开），缺失 / 目录进 `skipped`；
 *   ② 同一个文件重复声明只收一次（标签 id 就是路径，重复 = 两个标签抢一份草稿）；
 *   ③ 一个都不成立 → 抛错：否则模型会以为「已经交给用户了」，用户那边什么都没开；
 *   ④ `uiData.type = "present"` 是与 Rust / 前端约定的契约（铁律 1）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolResult } from '@/domain/tools/types'

// 安全校验只验「有没有走这条链」，路径原样返回（真实规则由 domain/security 的用例守）
vi.mock('@/services/security-service', () => ({
  securityService: {
    resolveSafePath: vi.fn(async (p: string) => p),
    getSkipEachDirs: vi.fn(async () => []),
  },
}))

import '@/infrastructure/tools/file'

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

/** 只在 pretend 的文件表上给 stat 结果：不认识的路径一律当不存在 */
function mockStat(table: Record<string, { dir?: boolean; size?: number }>) {
  vi.mocked(tauriFs.stat).mockImplementation((async (path: string) => {
    const hit = table[path.replace(/\\/g, '/')]
    if (!hit) throw new Error('ENOENT')
    return { isDirectory: !!hit.dir, isFile: !hit.dir, size: hit.size ?? 0 }
  }) as never)
}

describe('present（JS 回退路径）', () => {
  beforeEach(() => {
    vi.mocked(tauriFs.stat).mockReset()
  })

  it('存在的文件进 files，缺失 / 目录进 skipped，重复只收一次', async () => {
    mockStat({
      'out/report.xlsx': { size: 2048 },
      folder: { dir: true },
    })

    const tool = await toolRegistry.get('present')
    expect(tool).toBeDefined()

    const result = (await tool!.executor(
      { paths: ['out/report.xlsx', 'missing.pdf', 'folder', 'out/report.xlsx'] },
      makeCtx(),
    )) as ToolResult

    expect(typeof result).not.toBe('string')
    expect(result.content).toContain('Presented 1 file(s)')
    expect(result.content).toContain('Skipped 2 path(s)')
    expect(result.content).toContain('file does not exist')

    expect(result.uiData?.type).toBe('present')
    const files = result.uiData?.files as { path: string; name: string; sizeBytes: number }[]
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('out/report.xlsx')
    expect(files[0].name).toBe('report.xlsx')
    expect(files[0].sizeBytes).toBe(2048)

    const skipped = result.uiData?.skipped as { path: string; reason: string }[]
    expect(skipped.map((s) => s.path)).toEqual(['missing.pdf', 'folder'])
    expect(skipped[1].reason).toContain('directory')
  })

  it('单个 path 也认（与 read_file 同口径）', async () => {
    mockStat({ 'deck.pptx': { size: 10 } })
    const tool = await toolRegistry.get('present')
    const result = (await tool!.executor({ path: 'deck.pptx' }, makeCtx())) as ToolResult
    expect((result.uiData?.files as unknown[]).length).toBe(1)
  })

  it('一个都不成立 → 抛错（is_error），不让模型误以为已交付', async () => {
    mockStat({})
    const tool = await toolRegistry.get('present')
    await expect(
      tool!.executor({ path: 'missing.docx' }, makeCtx()),
    ).rejects.toThrow(/no file was presented/)
  })

  it('缺参 → 抛错，并说明要传什么', async () => {
    const tool = await toolRegistry.get('present')
    await expect(tool!.executor({}, makeCtx())).rejects.toThrow(
      /"path" or "paths" is required/,
    )
  })
})
