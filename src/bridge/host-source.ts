/**
 * 电脑侧真实 `HostDataSource` —— 把手机 RPC 落到本机 `sessionStore` / `chat-service`。
 *
 * 与 `virlen-remote/testing` 的 mock 宿主**共用同一份分发胶水**（`registerHostHandlers`），
 * 本文件只负责「数据从哪来」与「ACL / 审计」。
 *
 * 分工：
 * - **读**：`sessionStore`（listSessions / messages），白名单投影（`dto.ts`）；
 * - **写**：转发 `chat-service`（sendMessage 的**唯一入口**，杜绝旁路写 store）；
 * - **事件**：不在本文件推 —— 由 `store-bridge.ts` 用 mobx reaction 旁路订阅（§4.1）。
 */
import {
  BridgeError,
  type AnswerParams,
  type AnswerResult,
  type CompressParams,
  type ContextInfoDTO,
  type ContextParams,
  type CreateSessionParams,
  type CredentialRejectReason,
  type DeleteSessionParams,
  type GrantRecord,
  type HelloParams,
  type HelloResult,
  type HostDataSource,
  type ModelProviderDTO,
  type MsgPageDTO,
  type MsgPageParams,
  type PinSessionParams,
  type RenameSessionParams,
  type SendParams,
  type SessionSummaryDTO,
  type SetModelParams,
  type StreamMode,
  type WorkspaceOptionDTO,
} from 'virlen-remote'
import {
  agentStore,
  chatState,
  sessionRuntimeState,
  sessionStore,
  settingsState,
  updateSessionRuntime,
} from '@/ui/store'
import {
  activateSession,
  cancelMessage,
  compressContext,
  createSession,
  deleteSessions,
  getSessionMessages,
  renameSession,
  resumePausedRun,
  sendMessage,
  setSessionPinned,
  MAX_SESSION_TITLE_LEN,
} from '@/services/chat-service'
import {
  shouldCompress,
  toContextInfo,
} from '@/domain/usage/context-occupancy'
import { buildToolNameIndex, normalizeWorkspace, toMessageDTO, toRuntimeDTO, toSessionSummaryDTO } from './dto'
import type { Acl } from './acl'
import { previewOf, type AuditLog } from './audit'
import { PHONE_EVENTS, summarizeParams, tokenHash } from './telemetry'
import { track } from '@/utils/telemetry'
import type { InteractionRegistry } from './interaction-registry'
import type { PairingStore } from './pairing'
import type { SubscriptionRegistry } from './subscription'

export interface DesktopHostSourceDeps {
  pairing: PairingStore
  acl: Acl
  audit: AuditLog
  subscriptions: SubscriptionRegistry
  /** 待应答交互注册表（M4）—— 手机的回答由它校验并转发到电脑侧原有路径。 */
  interactions: InteractionRegistry
  deviceName: string
  deviceId: string
  /** 本机应用版本号（hello 应答用）。 */
  appVersion: string
  /**
   * 首次绑定确认（拍板：扫码 → 尝试绑定 → **电脑弹窗确认**）。
   * 票据首次兑换时调用；返回 false 则拒绝（`E_DENIED`）。
   * 不传时默认放行（仅测试 / 无人值守场景；生产必须传）。
   */
  confirmPair?: (ctx: { token: string; deviceName: string }) => Promise<boolean>
  /**
   * 手机在 `hello` 里声明的流式偏好（§32）；**只在握手成功的分支调**。
   *
   * 为何不在被拒时也调：拒绝不影响已经在链路上的那台手机（顶号前的旧连接），
   * 而改掉它的流式偏好会让它莫名其妙地多收几帧整段正文。
   */
  onStreamMode?: (mode: StreamMode) => void
  /**
   * 某会话被加入订阅集合时回调（`subscribe` / `createSession` 两条路径）。
   *
   * store-bridge用它**重置该会话的流式基准**：新订阅者手上的正文从零开始，
   * 沿用旧基准会发出 `offset` 对不上的增量（客户端得靠拉全文自纠）。
   */
  onSubscribe?: (sessionId: string) => void
}

export function createDesktopHostSource(deps: DesktopHostSourceDeps): HostDataSource {
  const {
    pairing,
    acl,
    audit,
    subscriptions,
    interactions,
    deviceName,
    deviceId,
    appVersion,
    confirmPair,
    onStreamMode,
    onSubscribe,
  } = deps

  const auditOp = (method: string, sessionId?: string, detail?: string): void => {
    audit.record({ method, allowed: true, sessionId, detail })
  }

  /** 会话存在性检查（四个写操作共用，避免各写一份）。 */
  const requireSession = (sessionId: string): void => {
    if (!sessionStore.getSession(sessionId)) {
      throw new BridgeError('E_NOT_FOUND', `会话不存在：${sessionId}`)
    }
  }

  /**
   * 新建会话可选的工作目录候选集（§22.3）。
   *
   * **全部来自电脑侧既有数据**（各会话的 workspace + 各 Agent 的 defaultWorkspace + 全局默认目录），
   * 手机端只能从中选，不能构造新路径 —— 「不能让手机端创建没有过的目录」。
   */
  const collectWorkspaces = (): WorkspaceOptionDTO[] => {
    const counts = new Map<string, number>()
    for (const session of sessionStore.listSessions()) {
      const path = normalizeWorkspace(session.workspace)
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    // Agent 默认目录 / 全局默认目录也算「已有」——它们是电脑侧设置里的既有值
    //（会话数为 0，恰好说明「有目录但还没建会话」，与「手机端凭空造目录」有本质区别）
    for (const agent of agentStore.listAgents()) {
      const path = normalizeWorkspace(agent.defaultWorkspace)
      if (path && !counts.has(path)) counts.set(path, 0)
    }
    const fallback = normalizeWorkspace(settingsState.value.defaultWorkspace)
    if (fallback && !counts.has(fallback)) counts.set(fallback, 0)
    return [...counts.entries()]
      .map(([path, sessionCount]) => ({
        path,
        name: path.split('/').pop() || path,
        sessionCount,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /** 新建会话可选的工作目录过滤（未在候选集内 = 越权，拒）。 */
  const requireWorkspace = (requested: string): string => {
    const normalized = normalizeWorkspace(requested)
    const allowed = normalized
      ? collectWorkspaces().find((w) => w.path === normalized)
      : undefined
    if (!allowed) {
      audit.record({
        method: 'host.session.create',
        allowed: false,
        detail: `工作目录不在电脑侧既有目录内：${previewOf(requested)}`,
      })
      throw new BridgeError('E_BAD_REQUEST', '该工作目录不在电脑侧既有目录内')
    }
    return allowed.path
  }

  /** 模型校验：服务必须已启用且该模型在其模型列表里（白名单投影的另一面）。 */
  const requireModel = (providerConfigId: string, modelId: string): void => {
    const provider = settingsState.value.providers.find((p) => p.id === providerConfigId)
    if (!provider || !provider.enabled) {
      throw new BridgeError('E_BAD_REQUEST', '模型服务不存在或未启用')
    }
    if (!provider.models.includes(modelId)) {
      throw new BridgeError('E_BAD_REQUEST', `该服务下没有模型：${modelId}`)
    }
  }

  return {
    async hello(params: HelloParams): Promise<HelloResult> {
      const token = params.token
      // 埋点参数摘要（与 `phone.rpc.call` 同一份口径）
      const helloProps = summarizeParams('host.hello', params)
      const verdict = pairing.authorize({ token, mobileKey: params.mobileKey })
      // §32：手机声明的流式偏好（只在下面的成功分支落地生效）
      const streamMode: StreamMode = params.streamMode === 'delta' ? 'delta' : 'full'

      // ⚠️ 本工程 tsconfig 显式关了 `strictNullChecks`，于是**布尔判别字段的真值判断不收窄联合**
      //（`if (verdict.ok)` 收窄不了，`if (verdict.ok === false)` 可以）—— 故这里一律写显式比较。
      if (verdict.ok === false) {
        // ── 首次配对：票据有效 → 桌面确认 → 签发凭证 ──
        if (verdict.reason === 'first-time') {
          const confirmStartedAt = Date.now()
          const approved = confirmPair ? await confirmPair({ token: token as string, deviceName }) : true
          track(PHONE_EVENTS.pairConfirm, {
            approved,
            asked: confirmPair != null,
            dur_ms: Date.now() - confirmStartedAt,
            token_hash: tokenHash(token),
          })
          if (!approved) {
            audit.record({ method: 'host.hello', allowed: false, detail: '用户拒绝配对' })
            track(PHONE_EVENTS.pairHello, { ...helloProps, ok: false, reason: 'user-denied' })
            throw new BridgeError('E_DENIED', '电脑端拒绝了本次配对', { data: { reason: 'denied' } })
          }
          const device = pairing.redeemTicket(token as string, {
            mobileKey: params.mobileKey,
            name: params.mobileName,
          })
          auditOp('host.hello', undefined, `platform=${params.client.platform} 首次配对：${device.name}`)
          track(PHONE_EVENTS.pairHello, {
            ...helloProps,
            ok: true,
            first_time: true,
            device_name: device.name,
            devices: pairing.list().length,
            grant_state: 'issued',
            grant_days_left: daysLeft(device.expiresAt),
          })
          onStreamMode?.(streamMode)
          return helloResult(params, { deviceName, deviceId, appVersion, acl, grant: grantOf(device) })
        }

        // ── 拒绝：手机端据此给不同文案（重新扫码 / 已被移除 / 二维码过期）──
        const message = describeReject(verdict.reason)
        audit.record({ method: 'host.hello', allowed: false, detail: message })
        track(PHONE_EVENTS.pairHello, { ...helloProps, ok: false, reason: verdict.reason })
        throw new BridgeError('E_DENIED', message, { data: { reason: verdict.reason } })
      }

      // ── 已授权：老设备凭凭证直连（顺带滑动续期）──
      const device = verdict.device
      auditOp('host.hello', undefined, `platform=${params.client.platform} device=${device.name}`)
      track(PHONE_EVENTS.pairHello, {
        ...helloProps,
        ok: true,
        first_time: false,
        device_name: device.name,
        devices: pairing.list().length,
        grant_state: 'renewed',
        grant_days_left: daysLeft(device.expiresAt),
      })
      onStreamMode?.(streamMode)
      return helloResult(params, { deviceName, deviceId, appVersion, acl, grant: grantOf(device) })
    },

    listSessions(): SessionSummaryDTO[] {
      acl.assert('session.list')
      auditOp('host.session.list')
      return sessionStore.listSessions().map(toSessionSummaryDTO)
    },

    async getMessages(params: MsgPageParams): Promise<MsgPageDTO> {
      acl.assert('session.list')
      requireSession(params.sessionId)
      // ⚠️ 分页游标（M5）：
      //  - 首页（无 `fromRowid`）：返回**已加载窗口的全部消息**（= `MESSAGE_PAGE_SIZE`）而非再 `slice` ——
      //    游标（rowid）只对「已加载窗口的最旧一条」成立，若展示窗口更窄，游标会指向窗口**之外**
      //    → 续页时漏掉中间消息（§20.2-A）。
      //  - 续页（有 `fromRowid`）：走桌面既有的「向上回补一页」唯一入口 `loadOlderMessages`。
      if (params.fromRowid != null) {
        const before = getSessionMessages(params.sessionId)
        await sessionStore.loadOlderMessages(params.sessionId)
        const after = getSessionMessages(params.sessionId)
        // 新增的 = 本页前插到头部的那一段（桌面侧保证升序前插）
        const added = after.slice(0, after.length - before.length)
        const paging = sessionStore.value.messagePaging[params.sessionId]
        auditOp('host.session.messages', params.sessionId, `older=${added.length}`)
        return {
          // 工具名索引从**已加载窗口**构建：工具调用与它的结果总是相邻（同一轮对话），
          // 跨页工具调用拿不到名字时只显示「工具」（手机端不猜）
          messages: added.map((m) => toMessageDTO(m, buildToolNameIndex(after))),
          hasMore: sessionStore.hasMoreMessages(params.sessionId),
          cursor: paging?.oldestRowid ?? null,
        }
      }
      await sessionStore.ensureMessagesLoaded(params.sessionId)
      const all = getSessionMessages(params.sessionId)
      const toolNames = buildToolNameIndex(all)
      const paging = sessionStore.value.messagePaging[params.sessionId]
      auditOp('host.session.messages', params.sessionId)
      return {
        messages: all.map((m) => toMessageDTO(m, toolNames)),
        hasMore: sessionStore.hasMoreMessages(params.sessionId),
        cursor: paging?.oldestRowid ?? null,
      }
    },

    getMessage(params: { sessionId: string; messageId: string }) {
      acl.assert('session.list')
      const loaded = getSessionMessages(params.sessionId)
      const found = loaded.find((m) => m.id === params.messageId)
      if (!found) throw new BridgeError('E_NOT_FOUND', `消息不存在：${params.messageId}`)
      auditOp('host.session.message.get', params.sessionId)
      return toMessageDTO(found, buildToolNameIndex(loaded))
    },

    send(params: SendParams) {
      acl.assert('session.send')
      requireSession(params.sessionId)
      // 并发保护：桌面端靠按钮禁用规避，手机是第二个操作源，必须由权威侧拦截
      if (sessionRuntimeState.value.sessions[params.sessionId]?.working) {
        throw new BridgeError('E_BUSY', '该会话正在回复中，请稍后再试')
      }
      const before = new Set(getSessionMessages(params.sessionId).map((m) => m.id))
      // fire-and-forget：RPC 只回「投递确认」，过程由 store-bridge 经事件推（§3.3）
      //
      // ⚠️ 必须带最小 events（2026-09-27 真机反馈修复）：桌面端错误条由 `onError` 驱动，
      //    缺省时手机触发的失败在电脑端**完全静默**（会话像「卡住」而无任何提示）。
      //    消息镜像同步**不**依赖这里 —— 已由 `sessionStore.onMessagesChanged` 兜底。
      void sendMessage(params.sessionId, params.text, {
        onError: (sid, error) => {
          // 与桌面发送路径同构：写会话运行时（跨会话保留），当前会话再同步到全局态立即展示
          updateSessionRuntime(sid, { error })
          if (sid === chatState.value.currentSessionId) {
            chatState.setValue('error', error)
          }
        },
      }).catch(() => {})
      const added = getSessionMessages(params.sessionId).find(
        (m) => !before.has(m.id) && m.role === 'user',
      )
      auditOp('host.session.send', params.sessionId)
      return { messageId: added?.id ?? '' }
    },

    async cancel(params: { sessionId: string }) {
      acl.assert('session.cancel')
      requireSession(params.sessionId)
      await cancelMessage(params.sessionId)
      // 取消后本次 run 的授权请求不会再被应答 → 收敛成终态，否则手机端留下僵尸卡片
      interactions.settleBySession(params.sessionId, 'expired')
      auditOp('host.session.cancel', params.sessionId)
      return { ok: true as const }
    },

    /**
     * 从暂停的 run 快照恢复执行（M5，与手机端「暂存」配对）。
     *
     * fire-and-forget：与 `send` 同理，RPC 只回投递确认，过程由 store-bridge 事件推。
     * **不**在这里额外校验「是否暂停」—— 交给 `resumePausedRun` 自身（无快照时报「没有可恢复的暂停任务」），
     * 避免出现第二条恢复路径（§3 原则）。
     */
    async resume(params: { sessionId: string }) {
      acl.assert('session.resume')
      requireSession(params.sessionId)
      void resumePausedRun(params.sessionId, {
        onError: (sid, error) => {
          updateSessionRuntime(sid, { error })
          if (sid === chatState.value.currentSessionId) {
            chatState.setValue('error', error)
          }
        },
      }).catch(() => {})
      auditOp('host.session.resume', params.sessionId)
      return { ok: true as const }
    },

    async subscribe(params: { sessionId: string }) {
      acl.assert('session.list')
      requireSession(params.sessionId)
      // 复用「进入会话」的数据侧唯一入口（懒加载 / 修复 / 未读清除）
      await activateSession(params.sessionId)
      subscriptions.add(params.sessionId, 'subscribe')
      // §32：新订阅者的流式基准必须归零（它手上没有正文，旧基准对不上）
      onSubscribe?.(params.sessionId)
      auditOp('host.session.subscribe', params.sessionId)
      return { ok: true as const }
    },

    // ───────────────────────── M4 写操作（§16.1）─────────────────────────

    async createSession(params: CreateSessionParams) {
      acl.assert('session.create')
      const title = (params.title ?? '').trim().slice(0, MAX_SESSION_TITLE_LEN)
      // 工作目录：**候选集校验**（越权防线在电脑侧，不靠手机端不显示 —— §7-⑪ 的教训）
      const workspace =
        params.workspace != null ? requireWorkspace(params.workspace) : undefined
      // 模型必须成对给出，且都在已启用服务的模型列表内
      const providerConfigId = params.providerConfigId?.trim() || undefined
      const modelId = params.modelId?.trim() || undefined
      if ((providerConfigId == null) !== (modelId == null)) {
        throw new BridgeError('E_BAD_REQUEST', '模型服务与模型 id 必须成对给出')
      }
      if (providerConfigId && modelId) requireModel(providerConfigId, modelId)
      // 走 chat-service 的 createSession（systemPrompt / Agent 默认值 / 工作目录的组装都在那里）
      const session = await createSession(title, providerConfigId, modelId, undefined, workspace)
      /**
       * ⚠️ 手机自建的会话**立即纳入订阅集合**（2026-09-29 真机缺陷，§24）。
       *
       * 为什么必须在这里兜住：消息 / 流式 / 运行时 / 占用四条通道都只推「已订阅」的会话
       * （见 `store-bridge` 的 `subscriptions.has(s.id)`），而**恒推**的只有会话列表 ——
       * 于是「创建后没 subscribe」的客户端会出现最迷惑的现象：**标题更新了，消息永远空白**。
       * 这条路径上手机端的意图是确定的（它创建会话就是为了马上发消息），
       * 且旧版缓存 PWA 未必带得上手机侧的新逻辑 —— 订阅不该押在客户端记得调一次 RPC 上。
       */
      subscriptions.add(session.id, 'create')
      onSubscribe?.(session.id)
      auditOp(
        'host.session.create',
        session.id,
        `${title || '（默认标题）'}${workspace ? ` @ ${workspace}` : ''}`,
      )
      return { sessionId: session.id }
    },

    renameSession(params: RenameSessionParams) {
      acl.assert('session.rename')
      requireSession(params.sessionId)
      if (!renameSession(params.sessionId, params.title)) {
        throw new BridgeError('E_BAD_REQUEST', '标题不能为空')
      }
      auditOp('host.session.rename', params.sessionId, previewOf(params.title))
      return { ok: true as const }
    },

    setPinned(params: PinSessionParams) {
      acl.assert('session.pin')
      if (!setSessionPinned(params.sessionId, params.pinned)) {
        throw new BridgeError('E_NOT_FOUND', `会话不存在：${params.sessionId}`)
      }
      auditOp('host.session.pin', params.sessionId, params.pinned ? 'pinned' : 'unpinned')
      return { ok: true as const }
    },

    async deleteSession(params: DeleteSessionParams) {
      acl.assert('session.delete')
      // ⚠️ 服务端**独立校验**（不依赖手机 UI 的二次确认）：不可逆操作，缺标记即拒（§16.3-3）
      if (params.confirm !== true) {
        audit.record({
          method: 'host.session.delete',
          allowed: false,
          sessionId: params.sessionId,
          detail: '缺少 confirm（未二次确认）',
        })
        throw new BridgeError('E_CONFIRM_REQUIRED', '删除会话需二次确认（confirm:true）')
      }
      requireSession(params.sessionId)
      // 唯一入口：先在引擎侧断流再删库（直调 store 会留下孤儿消息）
      const deleted = await deleteSessions([params.sessionId])
      subscriptions.remove(params.sessionId)
      interactions.settleBySession(params.sessionId, 'expired')
      auditOp('host.session.delete', params.sessionId, `deleted=${deleted}`)
      return { ok: true as const }
    },

    answer(params: AnswerParams): AnswerResult {
      acl.assert('interaction.answer')
      const result = interactions.answer(params)
      if (!result.accepted && result.reason === 'not-found') {
        // 注册表里没有 → 它自己不会留痕，这里补一条（常见原因：电脑上已经处理过了）
        audit.record({
          method: 'host.interaction.answer',
          kind: 'approval',
          allowed: false,
          by: 'mobile',
          interactionId: params.interactionId,
          detail: `交互已不存在（action=${params.action}）`,
        })
      }
      return result
    },

    /**
     * 当前待应答交互（拉取式）。
     *
     * 与事件的关系：事件是「增量」，本方法是「快照」——两者都要，因为手机可能
     * 在交互发起之后才连上（错过事件），也可能错过 `resolved`（本地残留僵尸卡片）。
     */
    listInteractions() {
      acl.assert('interaction.answer')
      return interactions.list()
    },

    // ─────────────────── §22：模型 / 工作目录 / 上下文 ───────────────────

    /** 已启用的模型服务与模型（白名单：**不含** apiKey / baseUrl / params）。 */
    listModels(): ModelProviderDTO[] {
      acl.assert('session.model')
      const providers = settingsState.value.providers
        .filter((p) => p.enabled && p.models.length > 0)
        .map((p) => ({ id: p.id, name: p.name, models: [...p.models] }))
      auditOp('host.model.list', undefined, `${providers.length} 个服务`)
      return providers
    },

    /**
     * 切换**已有会话**的模型（桌面 model-switcher 的等价操作）。
     *
     * 不校验 `working`：与桌面一致 —— 切换只改会话元数据（下一轮生效），
     * 当前这轮用的是引擎启动时拿到的会话快照。
     */
    setModel(params: SetModelParams) {
      acl.assert('session.model')
      requireSession(params.sessionId)
      requireModel(params.providerConfigId, params.modelId)
      // 唯一落点：与桌面 model-switcher 同一个 `updateSession`（不刷新 updatedAt ——
      // 会话时间只由「用户发送消息」刷新，切模型属元数据编辑）
      sessionStore.updateSession(params.sessionId, {
        providerConfigId: params.providerConfigId,
        modelId: params.modelId,
      })
      auditOp(
        'host.session.setModel',
        params.sessionId,
        `${params.providerConfigId}/${params.modelId}`,
      )
      return { ok: true as const }
    },

    /** 新建会话可选的工作目录（候选集；已有会话的工作目录不可改 —— 用户拍板）。 */
    listWorkspaces(): WorkspaceOptionDTO[] {
      acl.assert('session.workspace')
      const workspaces = collectWorkspaces()
      auditOp('host.workspace.list', undefined, `${workspaces.length} 个候选目录`)
      return workspaces
    },

    /**
     * 上下文占用快照（与桌面 token 环同一口径，`domain/usage/context-occupancy`）。
     *
     * 消息未加载时先补拉尾部窗口（否则 `tokens` 恒为 null）；确实无法判定时如实给 null，
     * 不编造 0（0 会被手机端误读成「上下文很空」）。
     */
    async getContext(params: ContextParams): Promise<ContextInfoDTO> {
      acl.assert('session.context')
      requireSession(params.sessionId)
      await sessionStore.ensureMessagesLoaded(params.sessionId)
      auditOp('host.session.context', params.sessionId)
      return toContextInfo(
        getSessionMessages(params.sessionId),
        settingsState.value.contextWindowTokens,
      )
    },

    /**
     * 压缩上下文（fire-and-forget）。
     *
     * 三道闸与桌面 token 环同构（不是另立标准）：
     * 1. `confirm:true`（不可逆操作，手机 UI 的确认不算数）；
     * 2. 正在回复 / 正在压缩 → `E_BUSY`；
     * 3. 占用未达 `COMPRESS_MIN_RATIO` → 拒（与桌面「当前上下文很充裕，无需压缩」同判据）。
     *
     * 过程不进本 RPC：进度走 `runtime.compacting`，结果走 `messages.reset`（手机重拉窗口）
     * 与 `message.added`（摘要消息）—— 与 `send` / `resume` 同形（§3.3）。
     */
    async compress(params: CompressParams) {
      acl.assert('session.compress')
      if (params.confirm !== true) {
        audit.record({
          method: 'host.session.compress',
          allowed: false,
          sessionId: params.sessionId,
          detail: '缺少 confirm（未二次确认）',
        })
        throw new BridgeError('E_CONFIRM_REQUIRED', '压缩上下文需二次确认（confirm:true）')
      }
      requireSession(params.sessionId)
      const rt = sessionRuntimeState.value.sessions[params.sessionId]
      if (rt?.working) throw new BridgeError('E_BUSY', '该会话正在回复中，无法压缩上下文')
      if (rt?.compacting) throw new BridgeError('E_BUSY', '该会话正在压缩中')
      await sessionStore.ensureMessagesLoaded(params.sessionId)
      const context = toContextInfo(
        getSessionMessages(params.sessionId),
        settingsState.value.contextWindowTokens,
      )
      if (!shouldCompress(context)) {
        throw new BridgeError('E_BAD_REQUEST', '当前上下文很充裕，无需压缩')
      }
      void compressContext(params.sessionId).catch(() => {})
      auditOp('host.session.compress', params.sessionId, `tokens=${context.tokens}`)
      return { ok: true as const }
    },
  }
}

/** 供 store-bridge 构造运行时 DTO（避免重复 import 面）。 */
export { toRuntimeDTO }

/* ───────────────────────── hello 应答的组装与拒绝文案（M6） ───────────────────────── */

/**
 * 组装 `host.hello` 应答。
 *
 * 首次配对与老设备直连**必须走同一个函数**：两条路径各拼一份密钥/字段，
 * 只会在「老设备能连、新设备连不上」这类真机现象里暴露（§26 的分叉缺陷就是这个形状）。
 */
function helloResult(
  params: HelloParams,
  deps: { deviceName: string; deviceId: string; appVersion: string; acl: Acl; grant: GrantRecord },
): HelloResult {
  return {
    protocolVersion: params.protocolVersion,
    host: { platform: 'desktop', appVersion: deps.appVersion },
    capabilities: deps.acl.capabilities,
    paired: true,
    deviceName: deps.deviceName,
    deviceId: deps.deviceId,
    grant: deps.grant,
  }
}

/** 只投影**凭证本身**（不要把整条设备记录，尤其是设备名字与内部 id，发回去）。 */
function grantOf(device: GrantRecord): GrantRecord {
  return {
    token: device.token,
    issuedAt: device.issuedAt,
    expiresAt: device.expiresAt,
    ...(device.lastSeenAt != null ? { lastSeenAt: device.lastSeenAt } : {}),
  }
}

/** 剩余天数（埋点用；避免在埋点里塞毫秒时间戳这种看不了的东西）。 */
function daysLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((expiresAt - now) / (24 * 60 * 60 * 1000)))
}

/**
 * 拒绝原因 → 手机端可直接显示的文案（**电脑端给什么，手机就显示什么**）。
 *
 * 为什么不让手机端自己按 reason 拼文案：手机端的每条文案都得跟着电脑端的原因集合走，
 * 多一处映射就多一处漂移（且旧版 PWA 根本没有新原因的分支）。
 */
function describeReject(reason: CredentialRejectReason | 'first-time' | 'ticket-expired'): string {
  switch (reason) {
    case 'expired':
      return '授权凭证已过期（最长 90 天），请在电脑端重新扫码配对'
    case 'revoked':
      return '该手机已被电脑端移除，请在电脑端重新扫码配对'
    case 'ticket-expired':
      return '二维码已过期，请在电脑端刷新二维码后重新扫码'
    case 'first-time':
      return '配对票据需要电脑端确认'
    default:
      return '令牌无效，或该设备已被电脑端移除'
  }
}
