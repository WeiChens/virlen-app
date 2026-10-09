/**
 * parse_document 工具（TS 回退路径）—— 转发契约测试
 *
 * 默认引擎（Rust）走原生工具，本执行器只在浏览器 dev / 回退路径生效；它**只做转发**：
 * 路径先过前端安全校验，再调 `cmd_parse_document`，命令侧与原生工具共用 core 的组装链
 * （所以这里只验「参数怎么传、结果怎么透传、失败怎么抛」）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { toolRegistry } from '@/domain/tools'
import { securityService } from '@/services/security-service'
import type { ToolContext, ToolExecutorResponse } from '@/domain/tools/types'

// Mock 安全服务：记录解析调用，并返回「已解析」的绝对路径
vi.mock('@/services/security-service', () => ({
  securityService: {
    resolveSafePath: vi.fn(async (p: string) => `/resolved${p.startsWith('/') ? '' : '/'}${p}`),
    getSkipEachDirs: vi.fn(async () => []),
  },
}))

// 引入文件工具模块（触发 parse_document 注册）
import '@/infrastructure/tools/file'

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

function toText(result: ToolExecutorResponse): string {
  if (typeof result === 'string') return result
  if ('content' in result) return result.content
  return JSON.stringify(result)
}

async function run(args: Record<string, any>) {
  const tool = await toolRegistry.get('parse_document')
  expect(tool).toBeDefined()
  return tool!.executor(args, makeCtx())
}

describe('parse_document（TS 回退执行器）', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    // 重建默认实现（用 mockImplementation 改过一次性行为的用例不能污染后面的用例）
    vi.mocked(securityService.resolveSafePath).mockReset()
    vi.mocked(securityService.resolveSafePath).mockImplementation(
      async (p: string) => `/resolved${p.startsWith('/') ? '' : '/'}${p}`,
    )
  })

  it('单文件：路径先过安全校验，再以 paths 数组交给命令', async () => {
    vi.mocked(invoke).mockResolvedValue({
      content: '📄 /resolved/a.docx\n\ntext',
      uiData: { file: '/resolved/a.docx', ok: true, fileType: 'docx' },
      ok: true,
    })

    const result = await run({ path: 'a.docx', sheet: 'Sheet1', max_chars: 500, offset: 20 })
    const text = toText(result)

    expect(text).toContain('text')
    expect(vi.mocked(securityService.resolveSafePath)).toHaveBeenCalledWith(
      'a.docx',
      'r',
      'test-session',
    )
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('cmd_parse_document', {
      paths: ['/resolved/a.docx'],
      sheet: 'Sheet1',
      maxChars: 500,
      offset: 20,
      outTxtFile: undefined,
    })
  })

  it('outTxtFile：以**写模式**过安全校验，并作为 outTxtFile 下发', async () => {
    vi.mocked(invoke).mockResolvedValue({
      content: '💾 Full text saved to /resolved/tmp/dump.txt',
      uiData: {
        file: '/resolved/a.pdf',
        ok: true,
        outTxtFile: { path: '/resolved/tmp/dump.txt', ok: true, charCount: 9 },
      },
      ok: true,
    })

    await run({ path: 'a.pdf', outTxtFile: 'tmp/dump.txt' })

    expect(vi.mocked(securityService.resolveSafePath)).toHaveBeenCalledWith(
      'tmp/dump.txt',
      'w',
      'test-session',
    )
    const [, payload] = vi.mocked(invoke).mock.calls[0] as [string, any]
    expect(payload.outTxtFile).toBe('/resolved/tmp/dump.txt')
  })

  it('outTxtFile 被写模式校验拒绝 → 抛出原因，不调命令', async () => {
    vi.mocked(securityService.resolveSafePath).mockImplementation(
      async (_p: string, mode: string) => {
        if (mode === 'w') {
          throw 'Path is outside the whitelist and the working directory; write access is limited to the whitelist and the working directory'
        }
        return '/resolved/a.pdf'
      },
    )

    await expect(run({ path: 'a.pdf', outTxtFile: 'C:/Windows/out.txt' })).rejects.toContain(
      'write access is limited',
    )
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('多文件：paths 优先，顺序与入参一致', async () => {
    vi.mocked(invoke).mockResolvedValue({ content: 'both', uiData: { files: [] }, ok: true })

    await run({ paths: ['a.pdf', 'b.xlsx'], path: 'ignored.txt' })

    const [, payload] = vi.mocked(invoke).mock.calls[0] as [string, any]
    expect(payload.paths).toEqual(['/resolved/a.pdf', '/resolved/b.xlsx'])
  })

  it('uiData 原样透传（界面侧不重建内容）', async () => {
    const uiData = {
      file: '/resolved/a.csv',
      ok: true,
      fileType: 'csv',
      charCount: 12,
      text: 'a,b\n',
    }
    vi.mocked(invoke).mockResolvedValue({ content: 'c', uiData, ok: true })

    const result = (await run({ path: 'a.csv' })) as { uiData?: any }
    expect(result.uiData).toEqual(uiData)
  })

  it('ok=false → 按失败抛出（与原生工具 Error 同语义）', async () => {
    vi.mocked(invoke).mockResolvedValue({
      content: 'Document parsing is not supported for .png',
      uiData: { file: '/resolved/a.png', ok: false, errorKind: 'unsupported' },
      ok: false,
    })

    await expect(run({ path: 'a.png' })).rejects.toContain('not supported for .png')
  })

  it('缺少 path / paths → 直接报协议级错误，不调命令', async () => {
    await expect(run({})).rejects.toContain('Missing required parameter')
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('路径被安全校验拒绝 → 抛出安全原因，不调命令', async () => {
    vi.mocked(securityService.resolveSafePath).mockRejectedValueOnce(
      'Path is blocked by the blacklist: ~/.ssh',
    )

    await expect(run({ path: '~/.ssh/id_rsa' })).rejects.toContain('blacklist')
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })
})
