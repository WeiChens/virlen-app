/**
 * execute_script 授权载荷 —— 回归：脚本授权弹窗必须能看到**脚本内容**。
 *
 * 背景：脚本授权弹窗原先只展示运行命令（如 `node temp/run.js`），用户无法据此判断
 * 脚本到底会做什么。现约定：`desc` = 脚本正文（file_content），`command` = 运行命令，
 * 由通用授权弹窗（`modals/authorization.tsx`）分两段渲染。
 */
import { describe, it, expect, vi } from 'vitest'

// 执行器会读工作目录 / 路径校验 / 权限决策；mock 掉安全服务（不接触 Tauri / 文件系统）
vi.mock('@/services/security-service', () => ({
  securityService: {
    getWorkspace: async () => 'C:/ws',
    resolveSafePath: async (p: string) => `C:/ws/${p}`,
    getPermissionDecision: async () => 'ask',
    // 「忽略沙盒命令」规则：本用例不命中（规则语义见 execute-command-sandbox-rule.test.ts）
    // 注：返回类型需显式标注 —— strictNullChecks=false 下 `null` 会退化成 any（TS7011）
    matchSandboxIgnoreRule: async (): Promise<null> => null,
  },
}))

import { toolRegistry } from '@/domain/tools'
import { UserInteractionRequired } from '@/domain/tools/types'
import '@/infrastructure/tools/execute/execute-script'

async function runExecutor(args: Record<string, any>) {
  const tool = await toolRegistry.get('execute_script')
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

describe('execute_script 授权载荷', () => {
  it('desc = 脚本内容、command = 运行命令、permName = script.execute', async () => {
    const body = "console.log('hello')\n"
    const res = await runExecutor({
      file_path: 'temp/run.js',
      file_content: body,
      command: 'node temp/run.js',
    })
    expect(res).toBeInstanceOf(UserInteractionRequired)
    const payload = (res as any).interactionData
    // 用户要看到的是脚本正文（据此判断是否放行）
    expect(payload.desc).toBe(body)
    // 运行命令作说明
    expect(payload.command).toBe('node temp/run.js')
    expect(payload.permName).toBe('script.execute')
    expect(payload.title).toBe('脚本命令执行')
  })
})
