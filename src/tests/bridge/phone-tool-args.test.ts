/**
 * 「工具调用气泡看不到入参」的真机反馈（2026-10）—— 电脑侧投影这一半。
 *
 * 现象：手机上的工具卡片只有工具名（`read_file` / `execute_command`），看不到**编辑的是哪个
 * 文件、执行的是什么命令** —— 而这正是用户判断「AI 干了什么」的唯一依据。
 *
 * 根因不是「坏了」而是「从未下行」：工具消息（`role:'tool'`）本身只有结果文本，名字与入参
 * 都在**发起该调用的 assistant 消息**的 `toolCalls[]` 上；电脑侧只把 `name` 投影进了 DTO。
 *
 * 本文件盯住投影层六条：
 * 1. 工具消息带上 `toolArgs`（从 `toolCalls[].input` 来，不是从正文猜）；
 * 2. 路径按**会话工作目录**缩短（与桌面卡片同口径）；
 * 3. **折叠态的摘要绝不下行正文**（`write_file.content` 整篇文章不能出现在那一行里）——
 *    但**展开区**（`toolArgsFull`）按用户要求给出完整入参：它是「用户主动点开才渲染」的那一块，
 *    总量由 `TOOL_DETAIL_MAX`（5000）兜住，超出**中间省略**；
 * 4. 工具输出同一条上限（`elideMiddle`），而 assistant / 用户正文一个字不裁；
 * 5. 拿不到就整个字段缺席（旧电脑端 / 跨页工具调用的行为不变）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createCaller,
  createMemoryPair,
  type HostApi,
} from 'virlen-remote'
import { startPhoneBridge, type PhoneBridge } from '@/bridge'
import { buildToolCallIndex, toMessageDTO } from '@/bridge/dto'
import { addSessionMessage } from '@/services/chat-service'
import { sessionStore } from '@/ui/store'
import type { Message, Session, ToolUseContent } from '@/types'

interface Harness {
  caller: ReturnType<typeof createCaller<HostApi>>
  bridge: PhoneBridge
  token: string
}

const cleanups: Array<() => void> = []

function setup(): Harness {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, { deviceName: '测试电脑', deviceId: 'host-test' })
  const device = bridge.pairing.register('测试手机')
  cleanups.push(() => {
    bridge.dispose()
    hostEp.dispose()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  return { caller: createCaller<HostApi>(mobileEp), bridge, token: device.token }
}

function makeSession(id: string, workspace: string): Session {
  const now = Date.now()
  return {
    id,
    title: '工具入参',
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SECRET',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    workspace,
  }
}

/** 一条 assistant 消息：带若干 `tool_calls`（入参就在这里）。 */
function assistantWithCalls(id: string, calls: ToolUseContent[]): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    toolCalls: calls,
    timestamp: Date.now(),
  }
}

function toolResult(id: string, toolCallId: string, content: string): Message {
  return { id, role: 'tool', content, toolCallId, timestamp: Date.now() }
}

const call = (id: string, name: string, input: Record<string, unknown>): ToolUseContent => ({
  type: 'tool_use',
  id,
  name,
  input,
})

beforeEach(() => {
  sessionStore.clear()
})

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
})

// ───────────────────────── 索引：名字 + 入参一次拿全 ─────────────────────────

describe('buildToolCallIndex —— 名字与入参一次拿全', () => {
  it('按 toolCallId 建索引，带上原始入参', () => {
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [call('tc1', 'read_file', { path: 'src/a.ts' })]),
      toolResult('t1', 'tc1', '文件内容'),
    ])
    expect(index.get('tc1')?.name).toBe('read_file')
    expect(index.get('tc1')?.input).toEqual({ path: 'src/a.ts' })
  })

  it('没有 toolCalls 的消息不产生条目（宁缺勿造）', () => {
    const index = buildToolCallIndex([toolResult('t1', 'missing', '文本')])
    expect(index.size).toBe(0)
  })
})

// ───────────────────────── 投影：toolArgs ─────────────────────────

describe('toMessageDTO —— 入参摘要', () => {
  it('工具消息带上主参数摘要（文件工具给路径，命令工具给命令）', () => {
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [
        call('tc1', 'edit_file', { path: 'src/a.ts', old_string: 'x', new_string: 'y\nz' }),
        call('tc2', 'execute_command', { command: 'npm test' }),
      ]),
    ])
    const edit = toMessageDTO(toolResult('t1', 'tc1', '已替换'), index)
    expect(edit.toolName).toBe('edit_file')
    expect(edit.toolArgs).toBe('src/a.ts · 减少 1行,新增 2行')

    const cmd = toMessageDTO(toolResult('t2', 'tc2', '用例全绿'), index)
    expect(cmd.toolArgs).toBe('npm test')
  })

  it('路径按会话工作目录缩短（与桌面卡片同一口径）', () => {
    const message = toolResult('t1', 'tc1', 'ok')
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [call('tc1', 'read_file', { path: 'E:/code/demo/src/a.ts' })]),
    ])
    sessionStore.saveSession(makeSession('s-ws', 'E:/code/demo'))
    // 不传会话：路径原样（拿不到工作目录就不缩短）
    expect(toMessageDTO(message, index).toolArgs).toBe('E:/code/demo/src/a.ts')
    expect(toMessageDTO(message, index, 'full', { sessionId: 's-ws' }).toolArgs).toBe('src/a.ts')
  })

  it('折叠态摘要绝不下行正文；正文只出现在展开区那份里，且不超上限', () => {
    const bigContent = Array.from({ length: 300 }, (_, i) => `第 ${i} 行内容`).join('\n')
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [call('tc1', 'write_file', { path: 'src/big.ts', content: bigContent })]),
    ])
    const dto = toMessageDTO(toolResult('t1', 'tc1', '已写入'), index)
    expect(dto.toolArgs).toBe('src/big.ts · 写入 300 行')
    expect(dto.toolArgs).not.toContain('第 0 行内容')
    // 展开区**要**给得出原文 —— 那正是「入参显示不完整」的修复本身
    expect(dto.toolArgsFull).toContain('第 0 行内容')
    expect(dto.toolArgsFull!.length).toBeLessThanOrEqual(5000)
    // 除了展开区那一个字段，报文里任何地方都不该有正文（尤其不能有两个副本）
    expect(JSON.stringify({ ...dto, toolArgsFull: undefined })).not.toContain('第 0 行内容')
  })

  it('拿不到工具调用（跨页 / 旧数据）→ 字段缺席，不猜', () => {
    const dto = toMessageDTO(toolResult('t1', 'tc1', '结果'))
    expect('toolName' in dto).toBe(false)
    expect('toolArgs' in dto).toBe(false)
    expect('toolArgsFull' in dto).toBe(false)
  })

  it('非工具消息不带这三个字段', () => {
    const user = toMessageDTO({
      id: 'u1',
      role: 'user',
      content: '你好',
      timestamp: 0,
    })
    expect('toolArgs' in user).toBe(false)
    expect('toolArgsFull' in user).toBe(false)
  })
})

// ───────────────────── 展开区：完整入参 + 5000 字符中间省略 ─────────────────────

describe('toMessageDTO —— 展开区的完整入参', () => {
  it('toolArgsFull：入参本身（pretty JSON），路径与折叠态**同一个**短路径', () => {
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [
        call('tc1', 'edit_file', {
          path: 'E:/code/demo/src/a.ts',
          old_string: 'x',
          new_string: 'y',
        }),
      ]),
    ])
    sessionStore.saveSession(makeSession('s-ws', 'E:/code/demo'))
    const dto = toMessageDTO(toolResult('t1', 'tc1', '已替换'), index, 'full', { sessionId: 's-ws' })
    // 折叠态：一行摘要
    expect(dto.toolArgs).toBe('src/a.ts · 减少 1行,新增 1行')
    // 展开态：主参数**之外**的键也在（摘要只挑 path，这正是「显示不完整」的那部分）
    expect(dto.toolArgsFull).toContain('"path": "src/a.ts"')
    expect(dto.toolArgsFull).toContain('"old_string": "x"')
    // 点开卡片后路径不能变样（否则用户以为点坏了什么）
    expect(dto.toolArgsFull).not.toContain('E:/code/demo')
  })

  it('toolArgsFull：整篇正文也在（用户主动点开），但超 5000 字符中间省略', () => {
    const content = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行`).join('\n')
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [call('tc1', 'write_file', { path: 'src/big.ts', content })]),
    ])
    const dto = toMessageDTO(toolResult('t1', 'tc1', '已写入'), index)
    expect(dto.toolArgs).toBe('src/big.ts · 写入 1200 行')
    // 与摘要反了一面：摘要是「只给摘要不给原文」，展开区是用户主动点开的现场
    expect(dto.toolArgsFull).toContain('第 0 行')
    expect(dto.toolArgsFull).toContain('第 1199 行')
    expect(dto.toolArgsFull).toContain('（中间省略')
    expect(dto.toolArgsFull!.length).toBeLessThanOrEqual(5000)
  })

  it('工具输出超 5000 字符：中间省略（头尾都留）；assistant / 用户正文一个字不动', () => {
    const output = `${'A'.repeat(3000)}${'B'.repeat(6000)}`
    const dto = toMessageDTO({
      id: 't1',
      role: 'tool',
      content: output,
      toolCallId: 'x',
      timestamp: 0,
    })
    expect(dto.text.length).toBeLessThanOrEqual(5000)
    expect(dto.text.startsWith('A')).toBe(true)
    expect(dto.text.endsWith('B')).toBe(true)
    expect(dto.text).toContain('（中间省略')

    // 助手正文是「主要内容」：砍它比砍工具输出更贵，一个字都不裁
    const long = 'C'.repeat(9000)
    expect(toMessageDTO({ id: 'a1', role: 'assistant', content: long, timestamp: 0 }).text).toBe(long)
    expect(toMessageDTO({ id: 'u1', role: 'user', content: long, timestamp: 0 }).text).toBe(long)
  })
})

// ───────────────────────── 投影：失败标记（isError） ─────────────────────────

describe('toMessageDTO —— 失败标记', () => {
  it('工具消息带 isError:true 时下发；缺席 = 没有失败标记（成功）', () => {
    // 成功（或旧数据）：字段缺席——手机端据此按 ✓ 渲染，不假装「结果未知」
    const ok = toMessageDTO(toolResult('t1', 'tc1', '用例全绿'))
    expect('isError' in ok).toBe(false)

    // 失败：`true` 才带（与桌面 `result.isError` 同一判据）
    const failed = toMessageDTO({ ...toolResult('t2', 'tc2', '命令退出码 1'), isError: true })
    expect(failed.isError).toBe(true)
    // 正文照旧投影，不因为失败而变样（手机端不靠正文反推成败）
    expect(failed.text).toBe('命令退出码 1')
  })
})

// ───────────────────────── 端到端：手机真的收得到 ─────────────────────────

/** `host.hello` 的最小合法载荷（与 `phone-bridge.test.ts` 同款）。 */
const helloParams = (token: string) => ({
  protocolVersion: 1,
  client: { platform: 'test', appVersion: '0' },
  capabilities: ['session.list'],
  mobileName: '测试手机',
  token,
})

describe('host.session.messages —— 手机拿到的是带摘要的投影', () => {
  it('拉窗口时工具消息带 toolArgs（路径已按工作目录缩短）', async () => {
    const h = setup()
    const hello = await h.caller.call('host.hello', helloParams(h.token))
    expect(hello.paired).toBe(true)

    sessionStore.saveSession(makeSession('s-args', 'E:/code/demo'))
    addSessionMessage('s-args', assistantWithCalls('a1', [call('tc1', 'read_file', { path: 'E:/code/demo/src/store/chat.ts' })]))
    addSessionMessage('s-args', toolResult('t1', 'tc1', 'src/store/chat.ts 的内容'))

    const page = await h.caller.call('host.session.messages', { sessionId: 's-args' })
    const tool = page.messages.find((m) => m.role === 'tool')
    expect(tool?.toolName).toBe('read_file')
    expect(tool?.toolArgs).toBe('src/store/chat.ts')
    // 展开区那一份也在同一次投影里（手机上无需再拉一轮 RPC）
    expect(tool?.toolArgsFull).toContain('"path": "src/store/chat.ts"')
  })

  it('拉窗口时失败的工具消息带 isError（手机不靠正文反推成败）', async () => {
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.token))

    sessionStore.saveSession(makeSession('s-err', 'E:/code/demo'))
    addSessionMessage('s-err', assistantWithCalls('a1', [call('tc1', 'execute_command', { command: 'npm test' })]))
    addSessionMessage('s-err', { ...toolResult('t1', 'tc1', '退出码 1'), isError: true })

    const page = await h.caller.call('host.session.messages', { sessionId: 's-err' })
    const tool = page.messages.find((m) => m.role === 'tool')
    expect(tool?.isError).toBe(true)
    expect(tool?.toolName).toBe('execute_command')
  })
})

// ───────────────────── 投影：两阶段加载（detail:'summary'） ─────────────────────

describe('toMessageDTO —— 两阶段加载摘要', () => {
  it('summary：省掉工具输出与完整入参，并打 deferred（不是 detail:omitted）', () => {
    const index = buildToolCallIndex([
      assistantWithCalls('a1', [call('tc1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
    ])
    const dto = toMessageDTO(toolResult('t1', 'tc1', '已写入'), index, 'full', { summary: true })
    // 两类重字段都省掉
    expect(dto.text).toBe('')
    expect('toolArgsFull' in dto).toBe(false)
    // 摘要信息照常（工具名 + 一行入参摘要）
    expect(dto.toolName).toBe('write_file')
    expect(dto.toolArgs).toBe('src/a.ts · 写入 1 行')
    // 打 deferred；且**不是** detail:'omitted'（那是「档位省略」，语义不同）
    expect(dto.deferred).toBe(true)
    expect('detail' in dto).toBe(false)
  })

  it('summary：没有重字段的工具消息不打 deferred（避免 UI 一直显示加载中）', () => {
    const dto = toMessageDTO(toolResult('t1', 'tc1', ''), undefined, 'full', { summary: true })
    expect(dto.deferred).toBeUndefined()
  })

  it('summary 不影响用户 / 助手正文（只省工具重字段）', () => {
    const user = toMessageDTO(
      { id: 'u1', role: 'user', content: '你好', timestamp: 0 },
      undefined,
      'full',
      { summary: true },
    )
    expect(user.text).toBe('你好')
    expect(user.deferred).toBeUndefined()
  })
})
