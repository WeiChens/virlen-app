/**
 * 轨迹视图的数据模型（纯数据结构，无 React / 无 i18n 依赖）。
 *
 * 轨迹视图把「聊天气泡流」重新摊平成**一张按轮次组织的事件表**：每条消息 / 每个工具调用
 * 各占一行，行上只留一个摘要与几个数字（token、耗时）。它不复制消息内容 —— 检查器
 * 直接引用原始 `Message`，避免两份正文漂移。
 *
 * ⚠️ 这里的类型刻意与 dsh（deepseek-harness）的 `TrajectoryCellProps` 同名同义
 * （kind / index / text / startedAt / timeSeconds → durationMs），方便日后对照阅读；
 * 但 virlen 没有事件溯源，所以没有 `sourceSeq` / `subtool` / `requestOnly` 这些字段。
 */
import type { Message, ToolUseContent } from '@/types'

/**
 * 行类型。
 *
 * - `system`：会话系统提示词（只有一行，来自 sessions.system_prompt）
 * - `user`：用户消息（一轮的起点）
 * - `context`：模型看不见的注入消息（`role='feedback'`：任务清单变更 / 后台服务结束通知）
 * - `message`：助手的一次回复（= 一次 LLM 请求，一轮内第 N 步）
 * - `tool`：一次工具调用 + 它的结果（配对后合成一行）
 * - `compacted`：压缩摘要（`role='summary'`）
 */
export type TrajectoryKind =
  | 'system'
  | 'user'
  | 'context'
  | 'message'
  | 'tool'
  | 'compacted'

/** 工具调用行里「参数 → 结果」两段摘要的长度上限（超出按 CSS 省略号截断） */
export const RECORD_TEXT_MAX = 240

/**
 * 消息文本为空时**为什么**空 —— 文案在 UI 层（domain 不碰 i18n）。
 * - `toolCallOnly`：只有工具调用，没有正文
 * - `noContent`：正文与工具调用都没有（空壳 / 崩溃残留）
 */
export type TrajectoryEmptyReason = 'toolCallOnly' | 'noContent'

/**
 * 用量账本（`usage_ledger`）里的一次 LLM 调用流水。
 *
 * 为什么轨迹要用它：virlen 的 `messages` 只留下「产生消息的那次请求」的结果，**没有请求本身的
 * 生命周期**（发出时刻 / 结束时刻 / 用的是哪个模型 / 有没有估算）。这些事实都在账本里，
 * 一次调用一条流水；`messageId` 就是 assistant 消息 id（chat_round 以它作幂等键），
 * 因此可以精确落到轨迹的「回复」行上。
 *
 * domain 不 import infrastructure，所以这里只保留轨迹用得到的字段 —— 由 UI 层从
 * `statsRepo.records()` 映射过来。
 */
export interface TrajectoryRequestFacts {
  /** 账本流水 id（检查器展示 / 去重） */
  id?: number
  /** 归属消息 id（`chat_round` = assistant 消息 id；标题 / 压缩 / 校验类没有） */
  messageId?: string
  /** 实际调用的模型（与「当前会话模型」不同时说明中途换过模型） */
  model?: string
  /** 提供方类型（openai / anthropic / gemini …） */
  provider?: string
  /** 调用类型：`chat_round`|`compress`|`title`|`verify`|`memory`|`embedding`|`legacy` */
  kind: string
  /** 第几轮（账本里的 `round`，只有 chat_round 有） */
  round?: number
  /** LLM 请求耗时（ms）；0 / 缺省 = 未测量（旧流水） */
  durationMs?: number
  /** 请求体实际字节数（JSON 序列化后）；缺省 = 未采集 */
  requestBytes?: number
  /** 发出请求 → 收到响应头（ms）；缺省 = 未采集 */
  responseStartMs?: number
  /** 发出请求 → 收到首个响应字节（ms）；缺省 = 未采集 */
  firstByteMs?: number
  /** 用量是本地估算（非 API 返回） */
  estimated?: boolean
  traceId?: string
  /** 调用完成时刻（Unix ms） */
  ts?: number
}

/**
 * 挂在一条记录上的请求事实（表格徽章 / 检查器「请求」页用）。
 *
 * 与 {@link TrajectoryRequestFacts} 的区别：这里只留**这条记录相关的**部分，并把
 * `tokensPerSecond` 这类派生值算好 —— UI 不该自己做除法与兜底判断。
 */
export interface TrajectoryRequestInfo {
  /** 账本流水 id */
  id?: number
  model?: string
  provider?: string
  /** 调用类型（`chat_round` 之外的值说明这是历史回填 / 摘要调用） */
  kind: string
  round?: number
  /** 账本实测的请求耗时（ms，含首字延迟）；未测量时为 undefined */
  durationMs?: number
  /**
   * 请求体实际字节数（JSON 序列化后的 UTF-8 长度）。
   *
   * 与 token 数不同：它包含工具定义 / 系统提示词 / 图片块 base64 等**原样发出去的内容**，
   * 所以能解释「为什么这次请求特别慢」（传输量与上传带宽都在它上面）。
   */
  requestBytes?: number
  /** 发出请求 → 收到响应头（ms）：纯网络 + 服务端排队，**不含**任何生成时间 */
  responseStartMs?: number
  /** 发出请求 → 收到首个响应字节（ms）：响应头 + 首 token 之前的一切 */
  firstByteMs?: number
  /** 用量为本地估算 */
  estimated?: boolean
  traceId?: string
  /** 输出速度（tok/s）：`output / 生成窗口`（请求耗时 − 等响应头耗时）；窗口未测或不足 1s 时为 undefined */
  tokensPerSecond?: number
  /**
   * 这条请求的模型与**上一次请求**不同（第一条请求也算）。
   *
   * 标记放在领域层算：会话中途换模型是几十条里偶发一次的“亮点”，只在该处显示徽章
   * 比给每行都挂一个相同模型更有信息量；而「上一条是什么」只有投影过程知道。
   */
  modelShift?: boolean
}

/**
 * 耗时的**来源**（决定界面上要不要加 `≈`）：
 * - `usage`：用量账本实测的 LLM 请求耗时（含首字延迟）—— 最可信
 * - `derived`：由「请求发出 → 第一个工具开跑」反推（含工具参数生成，但终点是工具开始，
 *   所以略小于真实请求耗时）
 * - `tool`：工具结果消息自带的 `elapsedMs`（引擎实测）
 *
 * 没有来源 = 算不出来（显示 `—`），绝不拿相邻消息的时间差充数。
 */
export type TrajectoryDurationSource = 'usage' | 'derived' | 'tool'

/**
 * 账本口径的会话级请求统计（`statsRepo.stats()` 的 totals，**整个会话、不受分页影响**）。
 *
 * 为什么单开一个结构而不与「窗口口径」混在一起：账本能数到标题 / 压缩 / 校验 / 记忆这些
 * **不产生消息**的调用，也包含窗口之外的轮次；而「实测耗时」「工具数」「失败数」只能从
 * 已加载的记录里数。两套数字混在同一个对象里，用户永远算不平（“总计 42 次但只看到 20 行”）。
 */
export interface TrajectoryLedgerStats {
  /** LLM 调用总次数（每次 provider 请求一条） */
  calls: number
  /** 其中普通对话请求次数（`kind='chat_round'`） */
  chatCalls: number
  /** 估算用量的调用次数（非 API 返回） */
  estimatedCalls: number
  input: number
  output: number
  /** 缓存命中（读取）量 */
  cached: number
  /** 缓存写入量（仅 Anthropic 等有该口径的提供方） */
  cacheWrite: number
  /** 缓存命中率（0..1）= cached / (input + cached + cacheWrite)；分母为 0 时 null */
  cacheHitRatio: number | null
}

/** 账本聚合的输入形状（由 UI 层从 `UsageStats.totals` 映射，domain 不 import infrastructure） */
export interface TrajectoryRequestTotals {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  calls: number
  estimatedCalls: number
  /** 其中普通对话请求（需要单独查一次 `kind='chat_round'` 的聚合才有） */
  chatCalls: number
}

/**
 * 窗口口径的轨迹统计（只数当前已加载的记录）。
 *
 * `measuredMs` / `measuredCalls` 是**唯一**能给出「真实请求耗时」的地方：账本的聚合桶
 * 没有耗时指标，所以只能从明细里数 —— 也就会跟着分页窗口一起变小。界面上必须把
 * 它标成「最近 N 次」而不是「全部」。
 */
export interface TrajectoryWindowStats {
  /** 轮次数（不含「会话开始」/ 压缩段） */
  turns: number
  /** 已加载的 LLM 请求（「回复」行）数 */
  steps: number
  /** 工具调用行数 */
  tools: number
  /** 失败记录数（含崩溃中断） */
  failures: number
  /** 已加载记录里的实测请求耗时合计（ms）；null = 一次都没测到 */
  measuredMs: number | null
  /** 有实测耗时的请求数 */
  measuredCalls: number
  /** 窗口内 token 合计（没有 usage 的记录不计） */
  input: number
  output: number
  cached: number
  cacheWrite: number
  /** 窗口内缓存命中率（口径同账本统计）；分母为 0 时 null */
  cacheHitRatio: number | null
}

/** 附件计数（用户消息行右侧那截「图片 2 · 文件 1」的数据来源） */
export interface TrajectoryAttachments {
  images: number
  files: number
  quotes: number
  skills: number
}

/** 检查器里一次工具调用的配对结果 */
export interface TrajectoryToolResult {
  /** 结果消息；`undefined` = 调用还没回来（或崩溃后没补上） */
  message?: Message
  /** 结果摘要（单行） */
  text: string
  isError: boolean
}

/** 轨迹表的一行。 */
export interface TrajectoryRecord {
  /** 投影内稳定身份（前插历史不换 key，虚拟列表才不会跳） */
  key: string
  /** 1 基行号（`#N`）；折叠 / 搜索都不改它，行号是「这条记录在会话里的位置」 */
  index: number
  kind: TrajectoryKind
  /** 主列摘要：单行、已压掉换行（工具行 = `工具名 + 参数 JSON`）；可能为空串，见 `emptyReason` */
  text: string
  /** `text` 为空时的原因（UI 落「（仅工具调用）」这类占位文案） */
  emptyReason?: TrajectoryEmptyReason
  /** 附件计数（仅用户消息；四个都为 0 时不带该字段） */
  attachments?: TrajectoryAttachments
  /** 压缩后上下文 token（仅 compressed 行；消息自带 `uiData.contextTokens` 时才有） */
  contextTokens?: number
  /**
   * 上下文注入消息的类型（`role='feedback'`）：任务清单变更 / 后台服务结束通知。
   * 这两种消息的正文是给模型看的（中文清单 / 英文报告），界面上按类型用界面语言重建 ——
   * 与聊天气泡同一口径（见 `message-bubble.tsx` 的 `isFeedback` 分支）。
   */
  noteKind?: 'todo' | 'service'
  /** 服务通知里的服务名（`uiData.name`） */
  noteName?: string
  /** 工具行的结果摘要（主列右侧那段）；其余行为空 */
  resultText?: string
  /** 工具行的参数摘要（`text` 里已包含工具名，这里单独留一份给 UI 分样式渲染） */
  argsText?: string
  /** 来源消息 id（跳回聊天 / 检索定位用） */
  messageId?: string
  /** 工具调用 id（assistant 的消息块与工具行之间唯一的关联键） */
  callId?: string
  /** 工具名（工具行 / 助手行的工具预览用） */
  toolName?: string
  /**
   * 这条记录对应的 LLM 请求事实（仅「回复」/「压缩」行；账本里查不到就没有该字段）。
   * 表格只在模型发生变化时才显示徽章，检查器的「请求」页则完整展示。
   */
  request?: TrajectoryRequestInfo
  /**
   * `durationMs` 的来源（`usage` = 账本实测 / `derived` = 反推 / `tool` = 工具结果实测）。
   * 缺省 = 没有耗时。表格用它在反推值前加 `≈`，检查器用它解释口径。
   */
  durationSource?: TrajectoryDurationSource
  /** 操作真实开始时刻（Unix ms）；未知为 undefined —— 未知就不画在时间轴上 */
  startedAt?: number
  /**
   * 该操作自身耗时（ms）。
   *
   * 只有**能真实算出来**的才给值，算不出来一律 `null`（表格显示 `—`）：
   * - 工具行 = 结果消息的 `elapsedMs`（引擎实测）
   * - 回复行 = **优先用量账本实测的请求耗时**（`usage_ledger.duration_ms`，含首字延迟）；
   *   账本里没这条流水时才退回到「请求发出 → 第一个工具开跑」的反推
   * - 用户 / 系统 / 上下文 / 压缩行 = 0 或 `null`（不占用时间）
   *
   * 之所以不用「下一条消息的时间戳 - 本条时间戳」：那段里混着用户阅读、切窗口、走开的时间，
   * 画进时间轴就是一条巨大的假横条（dsh 也只信 recorded 的计时）。
   *
   * 具体数字来自哪条路径看 {@link durationSource}。
   */
  durationMs: number | null
  /** 助手行的思考耗时（`reasoningElapsedMs`：首个思考增量 → 首个正文增量），未知为 undefined */
  thinkingMs?: number
  /** 提示词 token（assistant / 压缩行） */
  input?: number
  /** 补全 token */
  output?: number
  /** 命中缓存的输入 token */
  cached?: number
  /** 写入缓存的输入 token */
  cacheWrite?: number
  /** 失败（`isError`）或崩溃中断（`uiData.interrupted`） */
  isError?: boolean
  /** 还在进行中（流式正文没定稿 / 工具没回结果）—— 不给耗时，也不画成完整横条 */
  running?: boolean
  /** 原始消息（检查器正文 / 输入输出 / 思考）；system 行为 undefined */
  message?: Message
  /** 工具调用的配对结果（仅 tool 行） */
  result?: TrajectoryToolResult
  /** 工具调用参数（仅 tool 行，检查器「参数」页用） */
  toolCall?: ToolUseContent
  /** 系统提示词原文（仅 system 行） */
  systemPrompt?: string
}

/**
 * 组标题的结构化描述（文案在 UI 层）：
 * - `message`：本轮的用户消息（含附件、上下文注入）
 * - `step`：本轮第 N 次 LLM 请求
 * - `compaction`：第 N 段压缩
 */
export type TrajectoryGroupTitle =
  | { kind: 'message' }
  | { kind: 'step'; step: number }
  | { kind: 'compaction'; index: number }

/** 轮标题的结构化描述（文案在 UI 层） */
export type TrajectoryTurnTitle =
  | { kind: 'start' }
  | { kind: 'turn'; turn: number }
  | { kind: 'compaction'; index: number }

/** 一个分组：轮内的「消息」组 / 「第 N 步」组 / 独立的「压缩」section。 */
export interface TrajectoryGroup {
  /** 组内稳定 key（折叠态记账用） */
  key: string
  /** 组标题（结构化，UI 用 t/tpl 落文案） */
  title: TrajectoryGroupTitle
  records: TrajectoryRecord[]
  /** 组内已知耗时合计（ms）；一项都不知道时为 null */
  knownMs: number | null
}

/** 一个轮次（或一段独立的压缩 section）。 */
export interface TrajectoryTurn {
  /** 稳定 key（折叠态记账用） */
  key: string
  /** 轮次序号；`null` = 会话开头 / 独立的压缩 section（不参与「第 N 轮」编号） */
  turn: number | null
  /** 轮头标题（结构化，UI 用 t/tpl 落文案） */
  title: TrajectoryTurnTitle
  groups: TrajectoryGroup[]
  /** 轮内 token 合计（没有一条带 usage 时为 null） */
  input: number | null
  output: number | null
  /** 轮内已知耗时合计（ms）；null = 一项都不知道 */
  knownMs: number | null
}

/** `buildTrajectory` 的入参。 */
export interface TrajectoryBuildInput {
  messages: readonly Message[]
  /** 会话系统提示词（空串 / 缺省 = 不出系统行） */
  systemPrompt?: string | null
  /**
   * 用量账本的请求流水（按 `messageId` 落到「回复」行上）。
   * 缺省 = 纯消息投影，耗时只剩「反推」那一种来源。
   */
  usage?: readonly TrajectoryRequestFacts[]
}

/** 行类型的表格标签色 / 文案在 UI 层决定；这里只给「是否占时间轴泳道」的归类。 */
export type TrajectoryLane = 'input' | 'assistant' | 'tool'

/**
 * 记录所属的概览泳道（0 = 输入/上下文，1 = 助手，2 = 工具）。
 * 与 dsh 的三泳道一致：用户的提问、助手的回复、工具的执行，各自一条带子。
 */
export function laneOf(kind: TrajectoryKind): TrajectoryLane {
  if (kind === 'tool') return 'tool'
  if (kind === 'message' || kind === 'compacted') return 'assistant'
  return 'input'
}
