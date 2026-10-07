/**
 * ACL —— 手机控制的授权策略（**默认拒绝**，见 docs/phone-control-bridge.md §16.1）。
 *
 * assert() 不返回布尔而是抛 E_DENIED（让拒绝沿 RPC 统一报错）；能力集同时用于 hello 应答的
 * capabilities（取交集驱动 UI 显隐），**单一真源**。
 *
 * ⚠️ 能力集是「UI 显隐的依据」，不是唯一防线：每个 handler 仍各自 assert。
 */
import {
  BridgeError,
  COMPRESS_MODE_CAPABILITY,
  FILE_BROWSE_CAPABILITY,
  FILE_DOWNLOAD_CAPABILITY,
  FILE_EDIT_CAPABILITY,
  FILE_UPLOAD_CAPABILITY,
  MESSAGE_DELETE_CAPABILITY,
  MESSAGE_DETAIL_CAPABILITY,
  MESSAGE_FILE_CAPABILITY,
  MESSAGE_QUOTE_CAPABILITY,
  SESSION_AGENT_CAPABILITY,
} from 'virlen-remote'

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
  /** §22：查看已启用模型 + 切换已有会话的模型（看与切同一粒度：能看到却不给点会被当 bug）。 */
  | 'session.model'
  /** §22：查看「新建会话可选的工作目录」候选集。⚠️ 不含改已有会话目录（拍板：目录只在新建时确定）。 */
  | 'session.workspace'
  /** 查看上下文占用（配合对话压缩的决策）。 */
  | 'session.context'
  /** 压缩上下文（**破坏性**：需 confirm:true，与删除会话同档）。 */
  | 'session.compress'
  /**
   * §22：本机认识 CompressParams.mode —— **功能标记**（非权限，不会被 assert 拦）。旧电脑端会静默忽略
   * mode 并按自己的设置压缩。绑共享包常量：名字是两端契约，手写字符串迟早两边写岔。
   */
  | typeof COMPRESS_MODE_CAPABILITY
  /**
   * §22：新建会话时选定 Agent —— **权限**：归属 Agent 决定 systemPrompt / 工具白名单 / skills / 默认参数，
   * 选 Agent 就是选一套授权范围。绑共享包常量。
   */
  | typeof SESSION_AGENT_CAPABILITY
  /** §33：按链路类型裁剪下行正文 —— **功能标记**（手机据 hello 判断本机是否支持档位）。 */
  | typeof MESSAGE_DETAIL_CAPABILITY
  /** §36：删除单条消息（及其之后全部）—— 不可逆截断历史，是**权限**，handler 独立 assert。 */
  | typeof MESSAGE_DELETE_CAPABILITY
  /** §36：结构化引用（SendParams.quotes）—— **功能标记**（引用本是 session.send 的参数）。 */
  | typeof MESSAGE_QUOTE_CAPABILITY
  /** §37：列目录 / 读文件元信息（手机文件面板最低门槛）—— **权限**；越权防线在 resolveSafePath。 */
  | typeof FILE_BROWSE_CAPABILITY
  /** §37：读文件内容（预览与下载同路）。与 file.browse 分开：能看文件名 ≠ 能看内容。 */
  | typeof FILE_DOWNLOAD_CAPABILITY
  /** §37：上传（往工作目录新增文件）—— **真权限**，默认开，handler 独立 assert。 */
  | typeof FILE_UPLOAD_CAPABILITY
  /**
   * §37：改写已有文件（overwrite: true）。与上传分开：把已有文件内容换掉比多一个文件危险。
   * ⚠️ 同时是**功能标记**：旧电脑端会静默忽略 overwrite（一次覆盖退化成另存为副本）。
   */
  | typeof FILE_EDIT_CAPABILITY
  /** §37：文件引用（SendParams.files）—— **功能标记**（本是 session.send 的参数；与 file.browse 无关）。 */
  | typeof MESSAGE_FILE_CAPABILITY

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
  // §22：压缩方式可选（功能标记：旧电脑端上只给一个「压缩上下文」按钮）
  COMPRESS_MODE_CAPABILITY,
  // §22：新建会话时选定 Agent（权限）
  SESSION_AGENT_CAPABILITY,
  // §33：支持传输档位（裁剪 + 省略标记）—— 功能标记
  MESSAGE_DETAIL_CAPABILITY,
  // §36：删除是权限，引用是功能标记
  MESSAGE_DELETE_CAPABILITY,
  MESSAGE_QUOTE_CAPABILITY,
  // §37：工作目录文件，四档全开（用户 2026-10 拍板）
  FILE_BROWSE_CAPABILITY,
  FILE_DOWNLOAD_CAPABILITY,
  FILE_UPLOAD_CAPABILITY,
  FILE_EDIT_CAPABILITY,
  MESSAGE_FILE_CAPABILITY,
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
