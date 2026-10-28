// @vitest-environment node
/**
 * MCP 工具调用的授权 handles（`services/tool-service/mcp_confirm`）。
 *
 * 与命令审批共用「授权」这条通道，但**不执行任何东西**：允许只是把 `'approved'` 回给 Rust
 * （`mcp/bridge.rs` 收到后才真的 `tools/call`）。本文件钉住五条：
 *   ① 挂起即弹授权（载荷形状：permName / 副标题 / 参数正文）并计入侧边栏徽标；
 *   ② 允许 → resolve `'approved'` + 广播 `interactionSettled:'allow'`；
 *   ③ 拒绝 → reject；暂存 → reject 且 `name === 'InteractionShelved'`（引擎据此暂停 run）；
 *   ④ 运行结束收敛 → reject 且 `name === 'InteractionEnded'`（不是「用户取消」）；
 *   ⑤ 别人的 interactionId 一律忽略（多槽 + 跨 handles 不串）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import toolInteractEvent from '@/events/toolInteractEvent'
import { createMcpConfirmHandles } from '@/services/tool-service/mcp_confirm'
import { toolService } from '@/services/tool-service'
import {
  pendingInteractionCount,
  setPendingInteractionCount,
} from '@/ui/store/pendingInteractionStore'

const SESSION = 's-mcp'

beforeEach(() => {
  setPendingInteractionCount(SESSION, 0)
})

/** `mcp/bridge.rs` 下发的载荷（字段名照抄，少一个前端就少一块信息） */
const PAYLOAD = {
  permName: 'mcp.fs.call',
  title: 'MCP 工具调用',
  subTitle: 'fs · read_file',
  desc: '{\n  "path": "/tmp/a.txt"\n}',
  hint: '该调用会交给外部 MCP 服务器执行，可能读写文件或访问网络',
  risk: 'dangerous',
  toolCallId: 'tc-1',
  serverName: 'fs',
  toolName: 'read_file',
}

/** 挂起一次授权，返回 Promise 与捕获到的 interactionId */
function hang(handles: ReturnType<typeof createMcpConfirmHandles>) {
  const seen: any[] = []
  const off = toolInteractEvent.on('showAuthorization', (payload) => seen.push(payload))
  const promise = handles.handler('confirm_mcp_call', { ...PAYLOAD })
  off()
  return { promise, interactionId: seen[0]?.interactionId as string, payload: seen[0] }
}

describe('mcp_confirm：ask 档的授权', () => {
  it('挂起 → 弹授权（形态与命令审批同构）+ 徽标 +1', async () => {
    const handles = createMcpConfirmHandles(SESSION)
    const { promise, payload } = hang(handles)

    expect(payload.permName).toBe('mcp.fs.call')
    expect(payload.subTitle).toBe('fs · read_file')
    expect(payload.desc).toContain('/tmp/a.txt')
    expect(payload.toolCallId).toBe('tc-1')
    expect(payload.risk).toBe('dangerous')
    expect(pendingInteractionCount(SESSION)).toBe(1)

    handles.cleanup()
    await expect(promise).rejects.toThrow()
  })

  it('允许 → resolve `approved`，并广播 allow（另一应答端据此收 UI）', async () => {
    const handles = createMcpConfirmHandles(SESSION)
    const settled: Array<[string, string]> = []
    const off = toolInteractEvent.on('interactionSettled', (id, outcome) =>
      settled.push([id, outcome]),
    )
    const { promise, interactionId } = hang(handles)

    toolInteractEvent.emit('commandResolve', interactionId, '')
    await expect(promise).resolves.toBe('approved')
    expect(settled).toEqual([[interactionId, 'allow']])
    expect(pendingInteractionCount(SESSION)).toBe(0)

    off()
    handles.cleanup()
  })

  it('拒绝 → reject；暂存 → reject 且是 InteractionShelved', async () => {
    const handles = createMcpConfirmHandles(SESSION)

    const denied = hang(handles)
    toolInteractEvent.emit('commandReject', denied.interactionId, '用户拒绝了该命令')
    await expect(denied.promise).rejects.toBe('用户拒绝了该命令')

    const shelved = hang(handles)
    toolInteractEvent.emit('commandReject', shelved.interactionId, 'shelve:稍后再说')
    await expect(shelved.promise).rejects.toMatchObject({ name: 'InteractionShelved' })

    handles.cleanup()
  })

  it('运行结束收敛 → InteractionEnded（不是用户取消）', async () => {
    const handles = createMcpConfirmHandles(SESSION)
    const { promise } = hang(handles)
    const settled: string[] = []
    const off = toolInteractEvent.on('interactionSettled', (_id, outcome) =>
      settled.push(outcome),
    )

    handles.cleanup()
    await expect(promise).rejects.toMatchObject({ name: 'InteractionEnded' })
    expect(settled).toEqual(['expired'])
    expect(pendingInteractionCount(SESSION)).toBe(0)
    off()
  })

  it('未知 / 已应答的 interactionId 一律忽略（幂等，不串会话）', async () => {
    const handles = createMcpConfirmHandles(SESSION)
    const other = createMcpConfirmHandles('s-other')

    const mine = hang(handles)
    const theirs: any[] = []
    const off = toolInteractEvent.on('showAuthorization', (p) => theirs.push(p))
    const otherPromise = other.handler('confirm_mcp_call', { ...PAYLOAD, permName: 'mcp.git.call' })
    off()

    // 拿别人的 id 去答：两个都不该 settle
    toolInteractEvent.emit('commandResolve', theirs[0].interactionId, '')
    await expect(otherPromise).resolves.toBe('approved')
    await expect(
      Promise.race([mine.promise, Promise.resolve('still-pending')]),
    ).resolves.toBe('still-pending')

    toolInteractEvent.emit('commandResolve', mine.interactionId, '')
    await expect(mine.promise).resolves.toBe('approved')

    handles.cleanup()
    other.cleanup()
  })

  it('toolService 把 `confirm_mcp_call` 路由到 MCP handles（不是拿未知类型抛错）', async () => {
    const { handler, cleanup } = await toolService.createToolHandles(SESSION)
    const seen: any[] = []
    const off = toolInteractEvent.on('showAuthorization', (p) => seen.push(p))
    const promise = handler('confirm_mcp_call', { ...PAYLOAD })
    off()

    expect(seen).toHaveLength(1)
    toolInteractEvent.emit('commandResolve', seen[0].interactionId, '')
    await expect(promise).resolves.toBe('approved')
    cleanup()
  })
})
