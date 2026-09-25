/**
 * 「忽略沙盒命令」规则 → **免脱壳审批 + 强制无沙盒执行**（TS 引擎路径）。
 *
 * 与 Rust 原生路径同语义（那边见 `execute_command.rs::test_execute_command_rule_hit_forces_bypass`
 * 与 `test_execute_command_rule_check_gating`）。本文件钉住三件容易分叉的事：
 *  1. 命中规则时**即使 AI 没传 `sandbox:"off"`**，也把 `bypassSandbox: true` 交给运行器
 *     （即「改成无沙盒模式执行」）；
 *  2. 「只免脱壳」：命令本身的风险审批仍然照旧（ask 就还是 ask，弹窗展示的是命令权限）；
 *  3. 边界：`deny` 优先；沙盒关闭（off）时规则不生效。
 *
 * 做法：mock 安全服务（注入「命中哪条规则」与权限三态）+ mock `runCommand`
 * （只观察它收到的 `bypassSandbox`），不碰 Tauri / 真实进程。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 当前「命中」的规则（null = 未命中）；由用例逐个注入 */
const hit: { rule: any } = { rule: null }
/** 权限三态表：name → allow | ask | deny（未列出的回 'ask'） */
const perms = new Map<string, 'allow' | 'ask' | 'deny'>()

vi.mock('@/services/security-service', () => ({
  securityService: {
    getWorkspace: async () => 'C:/ws',
    getPermissionDecision: async (name: string) => perms.get(name) ?? 'ask',
    matchSandboxIgnoreRule: async () => hit.rule,
  },
}))

// 真实现 + 替身 runCommand（断言 bypassSandbox，不真的执行命令）
vi.mock('@/infrastructure/tools/execute/common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, runCommand: vi.fn(async () => ({ content: 'ran' })) }
})

import { toolRegistry } from '@/domain/tools'
import { UserInteractionRequired } from '@/domain/tools/types'
import { settingsState } from '@/ui/store'
import { runCommand } from '@/infrastructure/tools/execute/common'
import '@/infrastructure/tools/execute/execute-command'

const PERM_INSTALL = 'terminal.install.execute'
const PERM_NORMAL = 'terminal.normal.execute'
const PERM_ESCAPE = 'sandbox.command.execute'

const RULE = {
  id: 'r1',
  name: '装依赖',
  enabled: true,
  kind: 'text',
  textMode: 'prefix',
  pattern: 'pnpm',
  caseSensitive: false,
}

async function runExecutor(args: Record<string, any>) {
  const tool = await toolRegistry.get('execute_command')
  expect(tool).toBeTruthy()
  const ctx: any = {
    sessionId: 's1',
    toolCallId: 'tc1',
    abortSignal: new AbortController().signal,
    write: () => {},
    skills: [],
  }
  return tool!.executor(args, ctx)
}

/** mock 的 runCommand 最近一次收到的 opts */
function lastRunOpts(): { bypassSandbox?: boolean } | undefined {
  const calls = vi.mocked(runCommand).mock.calls
  return calls.length ? (calls[calls.length - 1][5] as any) : undefined
}

beforeEach(() => {
  hit.rule = null
  perms.clear()
  vi.mocked(runCommand).mockClear()
  settingsState.setValue('sandboxMode', 'on')
})

describe('execute_command · 命中「忽略沙盒命令」规则（TS 引擎路径）', () => {
  it('AI 未申请 sandbox:"off"：命中规则也以「不使用沙盒」方式执行', async () => {
    hit.rule = RULE
    perms.set(PERM_INSTALL, 'allow')

    const res = await runExecutor({ command: 'pnpm install --frozen-lockfile' })

    // 未产生审批交互（规则免脱壳 + 命令权限 allow）
    expect(res).not.toBeInstanceOf(UserInteractionRequired)
    expect(lastRunOpts()?.bypassSandbox).toBe(true)
  })

  it('只免脱壳：命令权限仍为 ask 时照样弹窗，且展示的是命令权限（脱壳已被规则预先授权）', async () => {
    hit.rule = RULE
    perms.set(PERM_INSTALL, 'ask')
    perms.set(PERM_ESCAPE, 'ask')

    const res = await runExecutor({ command: 'pnpm install' })

    expect(res).toBeInstanceOf(UserInteractionRequired)
    const payload = (res as any).interactionData
    expect(payload.permName).toBe(PERM_INSTALL)
    expect(payload.sandboxBypass).toBe(true)
    // 弹窗要说明「为什么会绕沙盒」——规则名来自用户配置
    expect(payload.hint).toContain('装依赖')
    expect(payload.hint).toContain('忽略沙盒命令')
  })

  it('未命中规则：既有行为不变（不脱壳、不标 sandboxBypass）', async () => {
    perms.set(PERM_NORMAL, 'allow')

    const res = await runExecutor({ command: 'git status' })

    expect(res).not.toBeInstanceOf(UserInteractionRequired)
    expect(lastRunOpts()?.bypassSandbox).toBe(false)
  })

  it('命中规则也不能推翻「沙盒脱壳」权限的显式禁止（deny 优先）', async () => {
    hit.rule = RULE
    perms.set(PERM_INSTALL, 'allow')
    perms.set(PERM_ESCAPE, 'deny')

    // P4b：拒绝文案固定为英文，且只报**权限 name**（稳定 key，与设置页一一对应）
    await expect(runExecutor({ command: 'pnpm install' })).rejects.toThrow(
      `Operation denied by the permission settings: ${PERM_ESCAPE}`,
    )
    // 一条命令都没跑
    expect(vi.mocked(runCommand)).not.toHaveBeenCalled()
  })

  it('沙盒关闭（off）时规则不生效：不加脱壳标记（本来就不进沙盒）', async () => {
    settingsState.setValue('sandboxMode', 'off')
    hit.rule = RULE
    perms.set(PERM_INSTALL, 'allow')

    const res = await runExecutor({ command: 'pnpm install' })

    expect(res).not.toBeInstanceOf(UserInteractionRequired)
    expect(lastRunOpts()?.bypassSandbox).toBe(false)
  })
})
