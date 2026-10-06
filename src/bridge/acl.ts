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
  /**
   * §22：本机认识 `CompressParams.mode`（压缩方式可选）。
   *
   * ⚠️ 这是**功能标记**而不是权限（与 §36 的 `message.quote` 同类）：压缩本身的授权仍是
   * `session.compress`，本能力名只回答「本机认不认这个参数」。写进本表的用途是让手机端据此
   * 决定「给两个按钮还是只给一个」—— 旧电脑端不认 `mode` 时会**静默忽略**它，
   * 然后按电脑侧设置压缩（用户以为选了正文压缩，实际走的是 AI 摘要，还花了钱）。
   *
   * 用 `typeof` 绑到共享包的常量上：这个名字是**两端契约**（手机端在 `hello.capabilities` 里
   * 比对同一个），手写字符串迟早会一边写成 `session.compress.modes` 而无人发现。
   */
  | typeof COMPRESS_MODE_CAPABILITY
  /**
   * 新建会话时**选定 Agent**（`CreateSessionParams.agentId` / `host.agent.list`）。
   *
   * ⚠️ 这是**权限**而不是功能标记（与 §33 的 `message.detail` 不同）：归属 Agent 决定这条会话的
   * systemPrompt / 工具白名单 / skills / 默认参数（`chat-service.createSession`）——
   * 选一个 Agent 就是选一套授权范围。手机端不显示选择器只是 UI 收敛，handler 里照样独立 `assert`。
   *
   * 用 `typeof` 绑到共享包的常量上：这个名字是**两端契约**（手机端在 `hello.capabilities` 里
   * 比对同一个），手写字符串迟早会一边写成 `session.agents` 而无人发现。
   */
  | typeof SESSION_AGENT_CAPABILITY
  /**
   * §33：按链路类型**裁剪下行正文**（中继 / 类型未知 → 工具输出省略，带 `detail:'omitted'`）。
   *
   * ⚠️ 它不是权限，而是**功能标记**（与 `stream.delta` 同类，不会被 `assert()` 拦）——
   * 写进本表的用途是让手机端在 `hello` 应答里看到「本机电脑端支持档位」，
   * 从而把面板文案说得精确（否则手机无法区分「工具输出被策略省略」与「电脑端太旧、不支持省略」）。
   *
   * 用 `typeof` 绑到共享包的常量上：这个名字是**两端契约**（手机端在 `hello.capabilities` 里声明同一个），
   * 手写字符串迟早会一边写成 `message.details` 而无人发现。
   */
  | typeof MESSAGE_DETAIL_CAPABILITY
  /**
   * §36：删除单条消息（及其之后全部）。
   *
   * 与上面那个**不同，这是权限而不是功能标记**：它不可逆地截断历史（含用户还没看过的
   * 后续对话），所以 handler 里会独立 `assert` —— 手机端隐藏入口只是 UI 收敛（§7-⑪）。
   */
  | typeof MESSAGE_DELETE_CAPABILITY
  /**
   * §36：结构化引用（`SendParams.quotes` / `MessageDTO.quotes`）。
   *
   * 与 `MESSAGE_DETAIL_CAPABILITY` 同类，是**功能标记**（不会被 `assert()` 拦）：
   * 引用本身就是 `session.send` 的一个参数，不是新权限。写进本表的用途是让手机端知道
   * 「本机电脑端认识 `quotes`」——旧电脑端会静默丢掉它（用户以为引用了，AI 却当没看见）。
   */
  | typeof MESSAGE_QUOTE_CAPABILITY
  /**
   * §37：列目录 / 读文件元信息（**手机端文件面板的最低门槛**）。
   *
   * ⚠️ 它是**权限**而不是功能标记：范围是「这台手机能看电脑上这个项目的哪些文件」。
   * 真正的越权防线在 `securityService.resolveSafePath`（会话工作目录 + 黑白名单），
   * 本能力位只是「要不要开这个功能」的开关。
   */
  | typeof FILE_BROWSE_CAPABILITY
  /**
   * §37：读文件内容（预览与下载同一条路）。
   *
   * 为何与 `file.browse` 分开：能看「有哪些文件」与能看「文件里写了什么」是两种强度
   * （`.env` / 私钥文件恰好都是「看得到名字就很有价值」的那类），拆开才能只给前者。
   */
  | typeof FILE_DOWNLOAD_CAPABILITY
  /**
   * §37：上传（往工作目录里**新增**文件）。
   *
   * 默认开（用户拍板），但它是**真权限**：handler 里独立 `assert`，不靠手机端不显示入口。
   */
  | typeof FILE_UPLOAD_CAPABILITY
  /**
   * §37：**改写已有文件**（编辑保存：`host.file.write.begin` 带 `overwrite: true`）。
   *
   * 为何与上传分开：上传最坏只是让目录里**多一个文件**，而这里是把已有文件的内容换掉 ——
   * 那个文件可能是源码、也可能 AI 正在写它。分开之后「只让手机传照片、不让手机改代码」
   * 是一种能被表达出来的授权。
   *
   * ⚠️ 它同时是**功能标记**：旧电脑端会静默忽略 `overwrite` 字段（一次覆盖保存退化成
   * 「另存为 - 副本」，用户以为改了、原文件其实没动），所以手机端只在 `hello` 里看到这个名字时
   * 才显示「编辑」入口。默认开 —— 与其余三档同一口径（并线后可在设置里单独关掉）。
   */
  | typeof FILE_EDIT_CAPABILITY
  /**
   * §37：文件引用（`SendParams.files` / `MessageDTO.files`）—— 手机端把电脑上的文件挂在要发的
   * 消息上，电脑端组装成 `{type:'file'}` 内容块。
   *
   * ⚠️ 它是**功能标记**而非权限（与 `MESSAGE_QUOTE_CAPABILITY` 同类）：文件引用本身就是
   * `session.send` 的一个参数，越权防线仍是 `session.send`。写进本表的用途是让手机端知道
   * 「本机电脑端认识 `files`」—— 旧电脑端会把未知字段**静默丢掉**（用户以为附上了，
   * AI 却从未看到）。
   *
   * ⚠️ 与 `file.browse` 无关：能引用文件不依赖能列目录（引用的是**工作目录里**的东西，
   * 而它是否真能被模型读到是工具层的事 —— 与桌面端拖一个文件进输入框不需要任何授权同理）。
   * 真正把关的是 `session.send` + 共享包的形状校验（非法即 `E_BAD_REQUEST` 拒整条）。
   */
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
  // §22：压缩方式可选（功能标记：手机端在旧电脑端上就只给一个「压缩上下文」按钮）
  COMPRESS_MODE_CAPABILITY,
  // §22：新建会话时选定 Agent（权限；旧手机端不认识这个能力名，也就不会显示选择器）
  SESSION_AGENT_CAPABILITY,
  // §33：本机支持传输档位（裁剪 + 省略标记）—— 不是权限，是功能标记（见 `Capability`）
  MESSAGE_DETAIL_CAPABILITY,
  // §36：消息级操作 —— 删除是权限，引用是功能标记（同上）
  MESSAGE_DELETE_CAPABILITY,
  MESSAGE_QUOTE_CAPABILITY,
  // §37：工作目录文件 —— 四档全开（用户 2026-10 拍板；非中继门槛是另一条纪律，不在 ACL 里）
  FILE_BROWSE_CAPABILITY,
  FILE_DOWNLOAD_CAPABILITY,
  FILE_UPLOAD_CAPABILITY,
  // §37：覆写已有文件（编辑保存）—— 与上传分开的那一档，默认也开
  FILE_EDIT_CAPABILITY,
  // §37：消息里引用电脑上的文件（功能标记：旧电脑端会静默丢掉 `files`）
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
