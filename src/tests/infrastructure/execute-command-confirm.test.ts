/**
 * execute_command 的 `confirm:"terminal"`（Step 2 ①，TS 引擎路径）。
 *
 * TS 路径没有 PTY → 见到 `confirm:"terminal"` 必须**强制走审批弹窗**（语义不丢：
 * 用户仍然要人工确认才能执行），并在 payload 上带 `confirm:'terminal'` 供上层识别。
 * Rust 原生路径的终端内确认见 `src-tauri/.../execute_command.rs` 的端到端用例。
 */
import { describe, it, expect, vi } from 'vitest'

// 执行器会读工作目录与权限决策；这里 mock 掉安全服务（不接触 Tauri / 真实文件系统）
vi.mock('@/services/security-service', () => ({
  securityService: {
    getWorkspace: async () => 'C:/ws',
    // 返回 'allow'：等价于「无需弹窗」（旧 commandApprovalMode='none' 的语义）
    getPermissionDecision: async () => 'allow',
  },
}))

import { toolRegistry } from '@/domain/tools'
import { UserInteractionRequired } from '@/domain/tools/types'
import '@/infrastructure/tools/execute/execute-command'

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

describe('execute_command confirm:terminal（TS 引擎路径）', () => {
  it('工具定义包含 confirm 参数（LLM 可发现）', async () => {
    const tool = await toolRegistry.get('execute_command')
    expect(tool!.definition.parameters.properties.confirm).toBeTruthy()
  })

  it('confirm=terminal → 强制审批，返回带 confirm 标记的命令确认交互', async () => {
    // 审批模式为 none，但 confirm:terminal 必须强制审批（不能被静默执行）
    const res = await runExecutor({ command: 'npm login', confirm: 'terminal' })
    expect(res).toBeInstanceOf(UserInteractionRequired)
    const payload = (res as any).interactionData
    expect(payload.confirm).toBe('terminal')
    expect(payload.desc).toBe('npm login')
    // 'npm login' 归类为安装命令 → 展示对应权限唯一 key
    expect(payload.permName).toBe('terminal.install.execute')
  })

  it('未指定 confirm 且无需审批 → 不产生交互（回归）', async () => {
    let result: any
    try {
      result = await runExecutor({ command: 'echo hi' })
    } catch {
      // 非 Tauri 环境下 runCommand 会失败；关键是「没有走审批交互」
      result = 'threw'
    }
    expect(result).not.toBeInstanceOf(UserInteractionRequired)
  })
})
