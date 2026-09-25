/**
 * execute 组工具「模型侧固定英文」契约测试（P4b-②）
 *
 * 背景同 `file-tool-output-contract.test.ts` / `tool-output-contract.test.ts`：
 * `content`（含被抛出的错误文本）是「模型 + UI」双用途字段。
 *
 * execute 组此前只有 Rust 原生路径是英文（P3 译英），**TS 执行器仍是中文** ——
 * 于是 Linux/macOS 桌面端与浏览器 dev（TS 引擎回退路径）会向模型产出中文，
 * 与默认的 Rust 引擎分叉。本批把 TS 侧固定为英文，并**逐字对齐** Rust 侧文案
 * （铁律 1：同一套语义两份实现，模型侧文本必须一致）。
 *
 * 另外：「操作已被权限设置禁止」不再回落到本地化的权限中文名，改用**权限 name**
 * （稳定 key，语言无关；与设置页一一对应）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { toolRegistry } from '@/domain/tools'
import { settingsState } from '@/ui/store'
import type { ToolContext } from '@/domain/tools/types'

const mocks = vi.hoisted(() => ({
  getPermissionDecision: vi.fn(async () => 'allow' as string),
  matchSandboxIgnoreRule: vi.fn(async () => null as any),
  resolveSafePath: vi.fn(async (p: string) => `/mock/${p}`),
  getWorkspace: vi.fn(async () => '/mock/ws'),
}))

vi.mock('@/services/security-service', () => ({ securityService: mocks }))

// 触发工具注册（execute_command / execute_script）
import '@/infrastructure/tools/execute'

const CJK = /[\u4e00-\u9fff]/

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

/** 调用执行器并把「抛出」与「返回」统一成字符串（错误文本同样是模型侧文案） */
async function runText(name: string, args: any): Promise<string> {
  const tool = await toolRegistry.get(name)
  expect(tool, `${name} 应已注册`).toBeDefined()
  try {
    const r = (await tool!.executor(args, makeCtx())) as any
    if (typeof r === 'string') return r
    return String(r?.content ?? '')
  } catch (e: any) {
    return typeof e === 'string' ? e : (e?.message ?? String(e))
  }
}

beforeEach(() => {
  mocks.getPermissionDecision.mockResolvedValue('allow')
  mocks.matchSandboxIgnoreRule.mockResolvedValue(null)
  settingsState.setValue('sandboxMode', 'on')
  // execute_script 的「脚本已存在」分支：默认不存在，避免用例间相互影响
  vi.mocked(tauriFs.exists).mockResolvedValue(false)
})

describe('execute_command：模型侧报错固定英文（与 Rust 原生路径逐字一致）', () => {
  it('权限禁止 → 只报权限 name（语言无关，不再是本地化中文名）', async () => {
    mocks.getPermissionDecision.mockResolvedValue('deny')
    const text = await runText('execute_command', { command: 'echo hi' })

    expect(text).toBe(
      'Operation denied by the permission settings: terminal.normal.execute',
    )
    expect(text).not.toMatch(CJK)
  })

  it('只读沙盒 + 申请绕过 → 英文拒绝文案（与 Rust 侧逐字一致）', async () => {
    settingsState.setValue('sandboxMode', 'readonly')
    const text = await runText('execute_command', {
      command: 'echo hi',
      sandbox: 'off',
    })

    expect(text).toBe(
      'The sandbox is in read-only mode, so bypassing it to run a command is not allowed; switch the sandbox mode in settings first (or use a regular terminal)',
    )
    expect(text).not.toMatch(CJK)
  })
})

describe('execute_script：模型侧报错固定英文（与 Rust 原生路径逐字一致）', () => {
  it('缺少 file_path / command → 英文参数报错', async () => {
    expect(await runText('execute_script', {})).toBe(
      'Missing required parameter: "file_path"',
    )
    expect(await runText('execute_script', { file_path: 'temp/run.js' })).toBe(
      'Missing required parameter: "command"',
    )
  })

  it('只读沙盒 + 申请绕过 → 英文拒绝文案', async () => {
    settingsState.setValue('sandboxMode', 'readonly')
    const text = await runText('execute_script', {
      file_path: 'temp/run.js',
      file_content: 'console.log(1)',
      command: 'node temp/run.js',
      sandbox: 'off',
    })

    expect(text).toBe(
      'The sandbox is in read-only mode, so bypassing it to run a script is not allowed; switch the sandbox mode in settings first (or use a regular terminal)',
    )
    expect(text).not.toMatch(CJK)
  })

  it('权限禁止 → 只报权限 name', async () => {
    mocks.getPermissionDecision.mockResolvedValue('deny')
    const text = await runText('execute_script', {
      file_path: 'temp/run.js',
      file_content: 'console.log(1)',
      command: 'node temp/run.js',
    })

    expect(text).toBe(
      'Operation denied by the permission settings: script.execute',
    )
    expect(text).not.toMatch(CJK)
  })

  it('脚本文件已存在 → 英文拒绝覆盖文案', async () => {
    vi.mocked(tauriFs.exists).mockResolvedValue(true)

    const text = await runText('execute_script', {
      file_path: 'temp/run.js',
      file_content: 'console.log(1)',
      command: 'node temp/run.js',
    })

    expect(text).toBe(
      'Error: the script file already exists; refusing to overwrite it — /mock/temp/run.js',
    )
    expect(text).not.toMatch(CJK)
  })
})
