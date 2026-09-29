/**
 * DTO 投影（**白名单**）—— 手机控制「电脑侧接口层」的出参构造。
 *
 * 铁律（见 docs/phone-control-bridge.md §7-⑥/⑦）：**绝不 `{...session}` 再删字段**。
 * `Session` 含 `systemPrompt`（可达数十 KB）、`workspace`（本地绝对路径）、
 * `providerConfigId` / `allowedTools` / `params`，直接下行是数据泄露 + 流量事故。
 * 这里**只挑显式字段**，新增字段必须手动加入，杜绝"不小心多带"。
 *
 * 图片 / 文件等富内容一律降级为占位符（§7-⑦）：`ImageContent` 可能内嵌大段 base64，
 * 下行就是流量事故。图片引用（ref）留到二期。
 */
import type { Message, MessageContent, Session } from '@/types'
import { agentStore, sessionRuntimeState, settingsState } from '@/ui/store'
import type { MessageDTO, RuntimeDTO, SessionSummaryDTO } from 'virlen-remote'

/** 电脑侧 `MessageRole`（含 summary / feedback）→ 协议四角色白名单。 */
const ROLE_MAP: Record<Message['role'], MessageDTO['role']> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  summary: 'system',
  feedback: 'assistant',
}

/**
 * 把消息内容投影为纯文本（剥离 base64 / 富内容）。
 *
 * 同时被 store-bridge 用作「消息指纹」的一部分 —— 见 store-bridge 的下行 diff。
 */
export function projectContentToText(content: MessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image_url':
        parts.push('[图片]')
        break
      case 'file':
        parts.push(`[文件] ${block.name ?? block.path}`)
        break
      case 'quote':
        parts.push(`[引用] ${block.text}`)
        break
      case 'skill':
        parts.push(`[技能] ${block.name}`)
        break
      case 'tool_use':
        parts.push(`[工具调用] ${block.name}`)
        break
      case 'tool_result':
        parts.push('[工具结果]')
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * 归一化工作目录：与桌面 `securityService.getWorkspace` **同口径**（反斜杠→`/`、去尾斜杠）。
 *
 * 必须归一化后再下行：手机端会把它当作「同一性」的 key（分组、回传给
 * `host.session.create`），两份不同写法（`E:\a` / `E:/a/`）会被当成两个目录。
 */
export function normalizeWorkspace(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || undefined
}

/**
 * 构造「toolCallId → 工具名」索引。
 *
 * 工具结果的正文里**没有**工具名（只有结果文本），名字在**发起该调用的 assistant 消息**的
 * `toolCalls[].name` 上。匹配规则与桌面 `message-list/helpers.ts::resolveJumpAnchorId`
 * **完全一致**（同一个 `toolCallId` 对应同一条调用），否则手机与电脑会显示不同的工具名。
 */
export function buildToolNameIndex(messages: readonly Message[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call?.id && call.name) index.set(call.id, call.name)
    }
  }
  return index
}

export function toMessageDTO(message: Message, toolNames?: ReadonlyMap<string, string>): MessageDTO {
  const toolName =
    message.role === 'tool' && message.toolCallId
      ? toolNames?.get(message.toolCallId)
      : undefined
  return {
    id: message.id,
    role: ROLE_MAP[message.role] ?? 'system',
    text: projectContentToText(message.content),
    createdAt: message.timestamp,
    ...(toolName ? { toolName } : {}),
  }
}

/**
 * 会话摘要投影。
 *
 * ⚠️ 读运行时状态时**只读不建**（`sessionRuntimeState.value.sessions[id]?.working`）：
 * `getSessionRuntime()` 会在缺失时创建条目，而本函数会在 mobx reaction 的推导里被调用 ——
 * 在推导中写观测值会触发 MobX 告警 / 重入。这里用可选链规避。
 *
 * ⚠️ `working` 字段只映射引擎 run（**不并入**本地的 `preparing`，见 sessionRuntimeStore）：
 * 桌面端本地识别图片的那几秒，手机看到的是「空闲」，但它这时候发消息会被宿主侧以
 * `E_BUSY` 拦下（`host-source.send` 用 `isSessionRuntimeBusy`）—— 拦得住不够不成两个 run，
 * 只是提示晚一步出现。
 */
export function toSessionSummaryDTO(session: Session): SessionSummaryDTO {
  const rt = sessionRuntimeState.value.sessions[session.id]
  // 只读查询（`getAgent` 是纯查表，不会创建条目）；未关联 Agent / 服务商被删时字段缺省
  const agent = agentStore.getAgent(session.agentId)
  const provider = session.providerConfigId
    ? settingsState.value.providers.find((p) => p.id === session.providerConfigId)
    : undefined
  const workspace = normalizeWorkspace(session.workspace)
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    working: rt?.working === true,
    pinned: session.pinned === true,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(agent ? { agentName: agent.name } : {}),
    ...(workspace ? { workspace } : {}),
    ...(session.providerConfigId ? { providerConfigId: session.providerConfigId } : {}),
    ...(provider ? { providerName: provider.name } : {}),
    ...(session.modelId ? { modelId: session.modelId } : {}),
  }
}

export function toRuntimeDTO(sessionId: string): RuntimeDTO {
  const rt = sessionRuntimeState.value.sessions[sessionId]
  return {
    working: rt?.working === true,
    ...(rt?.paused ? { paused: true } : {}),
    ...(rt?.error ? { error: rt.error } : {}),
    ...(rt?.compacting ? { compacting: true } : {}),
    // 工具参数生成进度（§27）：有才带，无则不带字段（手机端 `undefined` = 无进度）
    ...(rt?.toolProgress ? { toolProgress: rt.toolProgress } : {}),
  }
}
