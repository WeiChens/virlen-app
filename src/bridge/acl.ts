/**
 * ACL —— 手机控制的授权策略（**默认拒绝**）。
 *
 * 策略（见 docs/phone-control-bridge.md §16.1）：
 * 只读 + 发消息 + 取消 + 回答提问 + **四项会话写操作（M4 开）**。
 *
 * 设计要点：
 * - `assert()` 不返回布尔而是**抛 `E_DENIED`** —— 让拒绝沿 RPC 统一报错，手机端 UI 直接可判；
 * - 能力集同时用于 `hello` 应答的 capabilities（取交集驱动 UI 显隐），**单一真源**。
 *
 * ⚠️ **能力集是「UI 显隐的依据」，不是唯一防线**：每个 handler 仍各自 `assert`（§7-⑪ 的教训——
 * 「手机不显示按钮」绝不能当作隔离）。
 */
import { BridgeError } from 'virlen-remote'

export type Capability =
  | 'session.list'
  | 'session.send'
  | 'session.cancel'
  | 'session.resume'
  | 'session.create'
  | 'session.rename'
  | 'session.pin'
  | 'session.delete'
  | 'interaction.answer'
  | 'stream.delta'
  // ── §22：模型 / 工作目录 / 上下文（查看与切换同一粒度）──
  /**
   * 查看已启用的模型 + 切换**已有会话**的模型。
   *
   * 为什么「看」与「切」不拆两个能力：手机上若能看到一个选择器却不能点，只会被当成 bug。
   * 模型切换与桌面 model-switcher 等价（仅改会话元数据，不触及安全边界）。
   */
  | 'session.model'
  /**
   * 查看「新建会话可选的工作目录」候选集。
   *
   * ⚠️ **不含「改已有会话目录」**：用户 2026-09-28 拍板 —— 工作目录只在新建会话时确定，
   * 已有会话不可改（否则 systemPrompt / AGENTS.md 快照会与新目录错配）。
   */
  | 'session.workspace'
  /** 查看上下文占用（配合对话压缩的决策）。 */
  | 'session.context'
  /** 压缩上下文（**破坏性**：用摘要替换历史，需 `confirm:true`，与删除会话同档）。 */
  | 'session.compress'

/** 默认允许的能力（M4 写操作全开 + §22 模型/目录/上下文 —— 用户拍板）。 */
export const DEFAULT_CAPABILITIES: Capability[] = [
  'session.list',
  'session.send',
  'session.cancel',
  'session.resume',
  'session.create',
  'session.rename',
  'session.pin',
  'session.delete',
  'interaction.answer',
  'stream.delta',
  'session.model',
  'session.workspace',
  'session.context',
  'session.compress',
]

export class Acl {
  private readonly allowed: Set<Capability>

  constructor(capabilities: Capability[] = DEFAULT_CAPABILITIES) {
    this.allowed = new Set(capabilities)
  }

  can(capability: Capability): boolean {
    return this.allowed.has(capability)
  }

  /** 未声明 = 拒绝（默认拒绝）。 */
  assert(capability: Capability): void {
    if (!this.allowed.has(capability)) {
      throw new BridgeError('E_DENIED', `该操作未授权：${capability}`)
    }
  }

  get capabilities(): Capability[] {
    return [...this.allowed]
  }
}
