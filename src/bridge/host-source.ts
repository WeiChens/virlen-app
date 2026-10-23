/**
 * 电脑侧真实 HostDataSource：把手机 RPC 落到 sessionStore / chat-service。
 * 读走 sessionStore + 白名单投影；写一律走 chat-service；事件由 store-bridge 推。
 */
import {
  BridgeError,
  COMPRESS_MODE_CAPABILITY,
  MESSAGE_DELETE_CAPABILITY,
  MESSAGE_DETAIL_CAPABILITY,
  compressModeOf,
  sanitizeFileRefs,
  type AgentOptionDTO,
  type AnswerParams,
  type AnswerResult,
  type CompressParams,
  type ContextInfoDTO,
  type ContextParams,
  type CreateSessionParams,
  type CredentialRejectReason,
  type DeleteMessageParams,
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
  type TransferTier,
  type WorkspaceOptionDTO,
} from 'virlen-remote'
import {
  agentStore,
  chatState,
  isSessionRuntimeBusy,
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
  deleteSessionMessage,
  deleteSessions,
  getSessionMessages,
  renameSession,
  resumePausedRun,
  sendMessage,
  setSessionPinned,
  MAX_SESSION_TITLE_LEN,
} from '@/services/chat-service'
import { buildUserContent } from '@/utils/messageContent'
import {
  shouldCompress,
  toContextInfo,
} from '@/domain/usage/context-occupancy'
import { buildToolCallIndex, isTransferableMessage, normalizeWorkspace, toMessageDTO, toRuntimeDTO, toSessionSummaryDTO } from './dto'
import type { Acl } from './acl'
import { previewOf, type AuditLog } from './audit'
import type { HostFiles } from './file-source'
import { PHONE_EVENTS, summarizeParams, tokenHash } from './telemetry'
import { track } from '@/utils/telemetry'
import type { InteractionRegistry } from './interaction-registry'
import { DEFAULT_DEVICE_NAME, normalizeDeviceName, type PairingStore } from './pairing'
import type { SubscriptionRegistry } from './subscription'

/** 一次 host.hello 的结论，链路级的授权事实：ok 之前 host.* 一律拒。 */
export type HelloOutcome =
  | { ok: true }
  | { ok: false; reason: CredentialRejectReason | 'denied' | 'ticket-expired' }

/**
 * 会话域的 HostDataSource（不含文件方法）；文件方法由 bridge/index.ts 装配。
 * 用 Omit 声明是为了漏拼时在装配处报错，而不是真机上才发现是空实现。
 */
export type DesktopHostSource = Omit<HostDataSource, keyof HostFiles>

export interface DesktopHostSourceDeps {
  pairing: PairingStore
  acl: Acl
  audit: AuditLog
  subscriptions: SubscriptionRegistry
  /** 待应答交互注册表：手机的回答由它校验并转发到电脑侧现有路径。 */
  interactions: InteractionRegistry
  deviceName: string
  deviceId: string
  /** 本机应用版本号（hello 应答用）。 */
  appVersion: string
  /**
   * 首次绑定确认（电脑弹窗）；返回 false 则拒绝。生产必须传，不传则默认放行。
   * mobileName 是请求方（手机）的名字，与 redeemTicket 同一套归一规则。
   */
  confirmPair?: (ctx: { token: string; mobileName: string }) => Promise<boolean>
  /** 手机在 hello 里声明的流式偏好；只在握手成功时调。 */
  onStreamMode?: (mode: StreamMode) => void
  /**
   * 当前传输档位：lean 时工具输出正文不下发。存为函数是因为链路类型会变，
   * 每次拉取重读才能跟上。不传 = 'full'。
   */
  transferTier?: () => TransferTier
  /** 手机是否声明了能渲染「正文被省略」标记；旧客户端不认，必须继续全量发。 */
  onDetailSupport?: (supported: boolean) => void
  /** 会话被加入订阅集合时回调：store-bridge 据此重置该会话的流式基准。 */
  onSubscribe?: (sessionId: string) => void
  /** 每次 hello 的结论；三个分支（成功 / 用户拒 / 凭证或票据问题）都要报。 */
  onHelloResult?: (outcome: HelloOutcome) => void
  /** 收到 hello 请求的那一刻回调，早于一切 await（确认弹窗可能等几十秒）。 */
  onHelloReceived?: () => void
}

export function createDesktopHostSource(deps: DesktopHostSourceDeps): DesktopHostSource {
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
    onDetailSupport,
    onSubscribe,
    onHelloResult,
    onHelloReceived,
  } = deps

  const auditOp = (method: string, sessionId?: string, detail?: string): void => {
    audit.record({ method, allowed: true, sessionId, detail })
  }

  /** host.session.send 的审计说明：引用数 / 文件数，都为 0 则不带 detail。 */
  const sendAuditDetail = (quotes: number, files: number): string | undefined => {
    const parts: string[] = []
    if (quotes > 0) parts.push(`quotes=${quotes}`)
    if (files > 0) parts.push(`files=${files}`)
    return parts.length ? parts.join(' ') : undefined
  }

  /** 当前生效的传输档位，不缓存：拉取必须与推送同档，否则会出现「推送省了、拉取补回来」。 */
  const currentTier = (): TransferTier => deps.transferTier?.() ?? 'full'

  /** 会话存在性检查（四个写操作共用，避免各写一份）。 */
  const requireSession = (sessionId: string): void => {
    if (!sessionStore.getSession(sessionId)) {
      throw new BridgeError('E_NOT_FOUND', `会话不存在：${sessionId}`)
    }
  }

  /** 新建会话可选的工作目录候选集：全部来自电脑侧现有数据，手机端只能选不能造。 */
  const collectWorkspaces = (): WorkspaceOptionDTO[] => {
    const counts = new Map<string, number>()
    for (const session of sessionStore.listSessions()) {
      const path = normalizeWorkspace(session.workspace)
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    // Agent 默认目录 / 全局默认目录也算「现有」（会话数 0 不代表没有）
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

  /**
   * Agent 查找 + 校验。候选集由 host.agent.list 给出，这里再查一次表：
   * 手机传不存在的 id 一律拒，权限（可换 systemPrompt / 工具白名单）也在这一层兜。
   */
  const requireAgent = (requested: string) => {
    acl.assert('session.agent')
    const agent = agentStore.getAgent(requested.trim())
    if (!agent) {
      audit.record({
        method: 'host.session.create',
        allowed: false,
        detail: `Agent 不存在：${previewOf(requested)}`,
      })
      throw new BridgeError('E_BAD_REQUEST', '该 Agent 不存在（候选集见 host.agent.list）')
    }
    return agent
  }

  return {
    async hello(params: HelloParams): Promise<HelloResult> {
      // 先于一切 await：取消电脑端的握手截止兜底
      onHelloReceived?.()
      const token = params.token
      // 埋点参数摘要（与 `phone.rpc.call` 同一份口径）
      const helloProps = summarizeParams('host.hello', params)
      const verdict = pairing.authorize({ token, mobileKey: params.mobileKey })
      // 手机声明的流式偏好（只在成功分支生效）
      const streamMode: StreamMode = params.streamMode === 'delta' ? 'delta' : 'full'
      /* 是否声明了能渲染 detail:'omitted'；新能力名，旧客户端不认就别裁剪。 */
      const detailSupported =
        Array.isArray(params.capabilities) && params.capabilities.includes(MESSAGE_DETAIL_CAPABILITY)

      // tsconfig 关了 strictNullChecks：布尔判别字段的真值判断不收窄联合，一律显式比较
      if (verdict.ok === false) {
        // ── 首次配对：票据有效 → 桌面确认 → 签发凭证 ──
        if (verdict.reason === 'first-time') {
          const confirmStartedAt = Date.now()
          /* 弹窗显示的是手机的名字，归一与兜底必须与 redeemTicket 同一套。 */
          const requesterName = normalizeDeviceName(params.mobileName) ?? DEFAULT_DEVICE_NAME
          const approved = confirmPair
            ? await confirmPair({ token: token as string, mobileName: requesterName })
            : true
          track(PHONE_EVENTS.pairConfirm, {
            approved,
            asked: confirmPair != null,
            dur_ms: Date.now() - confirmStartedAt,
            token_hash: tokenHash(token),
          })
          if (!approved) {
            audit.record({ method: 'host.hello', allowed: false, detail: '用户拒绝配对' })
            track(PHONE_EVENTS.pairHello, { ...helloProps, ok: false, reason: 'user-denied' })
            // 拒绝就是拒绝：闸门不放行，界面也不该显示「已连接」
            onHelloResult?.({ ok: false, reason: 'denied' })
            throw new BridgeError('E_DENIED', '电脑端拒绝了本次配对', { data: { reason: 'denied' } })
          }
          let device: ReturnType<typeof pairing.redeemTicket>
          try {
            device = pairing.redeemTicket(token as string, {
              mobileKey: params.mobileKey,
              name: params.mobileName,
            })
          } catch {
            /* 票在确认弹窗期间失效：弹窗超过 TTL，或期间用户移除了另一台手机（revoke 会作废未使用的票）。 */
            onHelloResult?.({ ok: false, reason: 'ticket-expired' })
            audit.record({ method: 'host.hello', allowed: false, detail: '票据在确认期间失效' })
            track(PHONE_EVENTS.pairHello, { ...helloProps, ok: false, reason: 'ticket-expired' })
            throw new BridgeError('E_DENIED', describeReject('ticket-expired'), {
              data: { reason: 'ticket-expired' },
            })
          }
          // 票已兑换 = 正式获权（闸门放行、界面显示「已连接」）
          onHelloResult?.({ ok: true })
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
          onDetailSupport?.(detailSupported)
          return helloResult(params, { deviceName, deviceId, appVersion, acl, grant: grantOf(device) })
        }

        // ── 拒绝：手机端据此给不同文案 ──
        const message = describeReject(verdict.reason)
        audit.record({ method: 'host.hello', allowed: false, detail: message })
        track(PHONE_EVENTS.pairHello, { ...helloProps, ok: false, reason: verdict.reason })
        onHelloResult?.({ ok: false, reason: verdict.reason })
        throw new BridgeError('E_DENIED', message, { data: { reason: verdict.reason } })
      }

      // ── 已授权：老设备凭凭证直连（顺带滑动续期）──
      const device = verdict.device
      onHelloResult?.({ ok: true })
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
      onDetailSupport?.(detailSupported)
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
      // §33：档位一次读到底，同一次应答不许一半精简一半完整
      const tier = currentTier()
      // 两阶段加载：summary 只发摘要投影，重字段由手机按 id 再拉 full
      const summary = params.detail === 'summary'
      // 游标只对「已加载窗口最旧一条」成立；首页必须返回整个窗口，否则续页会漏消息
      if (params.fromRowid != null) {
        const before = getSessionMessages(params.sessionId)
        await sessionStore.loadOlderMessages(params.sessionId)
        const after = getSessionMessages(params.sessionId)
        // 新增的 = 本页前插到头部的那一段（桌面侧保证升序前插）
        const added = after.slice(0, after.length - before.length)
        const paging = sessionStore.value.messagePaging[params.sessionId]
        auditOp('host.session.messages', params.sessionId, `older=${added.length}`)
        return {
          /* 工具名索引从整个已加载窗口建：跨页拿不到时手机端只显示工具名，不猜 */
          messages: added.filter(isTransferableMessage).map((m) =>
            toMessageDTO(m, buildToolCallIndex(after), tier, {
              sessionId: params.sessionId,
              ...(summary ? { summary: true } : {}),
            }),
          ),
          hasMore: sessionStore.hasMoreMessages(params.sessionId),
          cursor: paging?.oldestRowid ?? null,
        }
      }
      await sessionStore.ensureMessagesLoaded(params.sessionId)
      const all = getSessionMessages(params.sessionId)
      const toolCalls = buildToolCallIndex(all)
      const paging = sessionStore.value.messagePaging[params.sessionId]
      auditOp('host.session.messages', params.sessionId)
      return {
        messages: all.filter(isTransferableMessage).map((m) =>
          toMessageDTO(m, toolCalls, tier, {
            sessionId: params.sessionId,
            ...(summary ? { summary: true } : {}),
          }),
        ),
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
      // 单条拉取与窗口拉取同档位；它只用于流式接不上时拉全文对齐
      return toMessageDTO(found, buildToolCallIndex(loaded), currentTier(), {
        sessionId: params.sessionId,
      })
    },

    send(params: SendParams) {
      acl.assert('session.send')
      requireSession(params.sessionId)
      // 并发保护：桌面端靠按钮禁用规避，手机是第二个操作源，必须由权威侧拦截。
      // 判据含 preparing：桌面端刚点发送、还在本地识别图片时也算在途，不能让手机起第二个 run
      const busyRt = sessionRuntimeState.value.sessions[params.sessionId]
      if (busyRt && isSessionRuntimeBusy(busyRt)) {
        throw new BridgeError('E_BUSY', '该会话正在回复中，请稍后再试')
      }
      const before = new Set(getSessionMessages(params.sessionId).map((m) => m.id))
      /*
       * 文件引用：组装成与桌面输入框同一条路径的内容块（buildUserContent 的 files 位）。
       * 校验走共享包的 sanitizeFileRefs；形状非法拒整条 —— 丢一条会让用户以为带上了。
       */
      const fileRefs = sanitizeFileRefs(params.files)
      if (!fileRefs.ok) {
        audit.record({
          method: 'host.session.send',
          allowed: false,
          sessionId: params.sessionId,
          detail: `files 非法：${fileRefs.reason}`,
        })
        throw new BridgeError('E_BAD_REQUEST', fileRefs.reason)
      }
      /*
       * 引用与文件都走结构化内容块，顺序由 buildUserContent 定（quote → text → file）；
       * 两者都没有时保持裸字符串，不做变换。
       */
      const content =
        params.quotes?.length || fileRefs.files.length
          ? buildUserContent(params.text, [], fileRefs.files, params.quotes)
          : params.text
      /*
       * 与桌面「重发时清除错误」同构：不清的话旧错误会随运行时快照反复推给手机。
       * 全局态只在被操作的正是当前会话时清。
       */
      updateSessionRuntime(params.sessionId, { error: null })
      if (params.sessionId === chatState.value.currentSessionId) {
        chatState.setValue('error', null)
      }
      // fire-and-forget：只回投递确认，过程由 store-bridge 推。
      // 必须带 onError：桌面错误条由它驱动，缺省时手机触发的失败在电脑端完全静默
      void sendMessage(params.sessionId, content, {
        onError: (sid, error) => {
          // 与桌面发送同构：写会话运行时，当前会话再同步到全局态
          updateSessionRuntime(sid, { error })
          if (sid === chatState.value.currentSessionId) {
            chatState.setValue('error', error)
          }
        },
      }).catch(() => {})
      const added = getSessionMessages(params.sessionId).find(
        (m) => !before.has(m.id) && m.role === 'user',
      )
      auditOp('host.session.send', params.sessionId, sendAuditDetail(params.quotes?.length ?? 0, fileRefs.files.length))
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

    /** 从暂停快照恢复执行；fire-and-forget，是否暂停交给 resumePausedRun 自己判断。 */
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
      // 复用「进入会话」的唯一入口（懒加载 / 修复 / 未读清除）
      await activateSession(params.sessionId)
      subscriptions.add(params.sessionId, 'subscribe')
      // 新订阅者手上没有正文，流式基准必须归零
      onSubscribe?.(params.sessionId)
      auditOp('host.session.subscribe', params.sessionId)
      return { ok: true as const }
    },

    // M4 写操作

    async createSession(params: CreateSessionParams) {
      acl.assert('session.create')
      const title = (params.title ?? '').trim().slice(0, MAX_SESSION_TITLE_LEN)
      // 工作目录按候选集校验，不靠手机端不显示（越权防线在电脑侧）
      const workspace =
        params.workspace != null ? requireWorkspace(params.workspace) : undefined
      // 模型必须成对给出，且都在已启用服务的模型列表内
      const providerConfigId = params.providerConfigId?.trim() || undefined
      const modelId = params.modelId?.trim() || undefined
      if ((providerConfigId == null) !== (modelId == null)) {
        throw new BridgeError('E_BAD_REQUEST', '模型服务与模型 id 必须成对给出')
      }
      if (providerConfigId && modelId) requireModel(providerConfigId, modelId)
      /* Agent 只在手机指定时查表（不传 = 电脑侧默认 Agent）；校验属于接口层，chat-service 还要服务桌面。 */
      const agent = params.agentId != null ? requireAgent(params.agentId) : undefined
      // 走 chat-service.createSession（systemPrompt / 默认值 / 工作目录的组装都在那里）
      const session = await createSession(title, providerConfigId, modelId, agent, workspace)
      /** 手机自建的会话立即纳入订阅集合：否则会出现「标题更新了，消息永远空白」。 */
      subscriptions.add(session.id, 'create')
      onSubscribe?.(session.id)
      auditOp(
        'host.session.create',
        session.id,
        `${title || '（默认标题）'}${workspace ? ` @ ${workspace}` : ''}${agent ? ` · Agent ${agent.name}` : ''}`,
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
      // 服务端独立校验，不依赖手机 UI 的二次确认
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

    /**
     * 删除单条消息及其之后的全部消息，与桌面右键菜单同一条落点。
     * 三道闸：confirm、会话不忙（与 send 同一判据）、不删工具消息。
     */
    deleteMessage(params: DeleteMessageParams) {
      acl.assert(MESSAGE_DELETE_CAPABILITY)
      if (params.confirm !== true) {
        audit.record({
          method: 'host.session.message.delete',
          allowed: false,
          sessionId: params.sessionId,
          detail: '缺少 confirm（未二次确认）',
        })
        throw new BridgeError('E_CONFIRM_REQUIRED', '删除消息需二次确认（confirm:true）')
      }
      requireSession(params.sessionId)
      const rt = sessionRuntimeState.value.sessions[params.sessionId]
      if (rt && isSessionRuntimeBusy(rt)) {
        throw new BridgeError('E_BUSY', '该会话正在回复中，请稍后再试')
      }
      const target = getSessionMessages(params.sessionId).find((m) => m.id === params.messageId)
      if (!target) throw new BridgeError('E_NOT_FOUND', `消息不存在：${params.messageId}`)
      if (target.role === 'tool') {
        throw new BridgeError('E_BAD_REQUEST', '工具消息不能单独删除')
      }
      /* 内存与 DB 都按同一锚点往后截，不会出现「内存删了 DB 没删」。 */
      if (!deleteSessionMessage(params.sessionId, params.messageId)) {
        throw new BridgeError('E_NOT_FOUND', `消息不存在或不允许删除：${params.messageId}`)
      }
      auditOp('host.session.message.delete', params.sessionId, `from=${params.messageId}`)
      return { ok: true as const }
    },

    answer(params: AnswerParams): AnswerResult {
      acl.assert('interaction.answer')
      const result = interactions.answer(params)
      if (!result.accepted && result.reason === 'not-found') {
        // 注册表里没有 → 它不会自留痕，这里补一条（常见：电脑上已处理过）
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

    /** 当前待应答交互（快照）。事件会给增量，但手机可能连上晚或错过 resolved。 */
    listInteractions() {
      acl.assert('interaction.answer')
      return interactions.list()
    },

    // 模型 / Agent / 工作目录 / 上下文

    /** 已启用的模型服务与模型（不含 apiKey / baseUrl / params）。 */
    listModels(): ModelProviderDTO[] {
      acl.assert('session.model')
      const providers = settingsState.value.providers
        .filter((p) => p.enabled && p.models.length > 0)
        .map((p) => ({ id: p.id, name: p.name, models: [...p.models] }))
      auditOp('host.model.list', undefined, `${providers.length} 个服务`)
      return providers
    },

    /** 切换已有会话的模型；不校验 working（与桌面一致，下一轮生效）。 */
    setModel(params: SetModelParams) {
      acl.assert('session.model')
      requireSession(params.sessionId)
      requireModel(params.providerConfigId, params.modelId)
      // 与桌面同一落点；不刷新 updatedAt，切模型属元数据编辑
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

    /** 新建会话可选的工作目录（已有会话的工作目录不可改）。 */
    listWorkspaces(): WorkspaceOptionDTO[] {
      acl.assert('session.workspace')
      const workspaces = collectWorkspaces()
      auditOp('host.workspace.list', undefined, `${workspaces.length} 个候选目录`)
      return workspaces
    },

    /**
     * Agent 候选集：只给 id / name / 默认模型 / 默认工作目录，不含 systemPrompt、
     * allowTools、skills、params。真正组装仍在 createSession 里。
     */
    listAgents(): AgentOptionDTO[] {
      acl.assert('session.agent')
      const agents = agentStore.listAgents().map((agent) => {
        const workspace = normalizeWorkspace(agent.defaultWorkspace)
        return {
          id: agent.id,
          name: agent.name,
          // 老数据可能缺默认模型 / 目录 → 缺了就不带字段
          ...(agent.defaultModel ? { defaultModel: { ...agent.defaultModel } } : {}),
          ...(workspace ? { defaultWorkspace: workspace } : {}),
        }
      })
      auditOp('host.agent.list', undefined, `${agents.length} 个候选 Agent`)
      return agents
    },

    /** 上下文占用快照。无法判定时如实给 null，不编造 0。 */
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
     * 压缩上下文（fire-and-forget）。闸门与桌面 token 环同构：confirm、不忙、已达压缩阈值、
     * mode 必须可识别（未知取值直接拒，不落回缺省）。
     * 进度走 runtime.compacting，结果走 messages.reset / message.added。
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
      /* 不传 mode（旧手机端）= 沿用桌面设置；传了则独立校验取值。 */
      const mode = params.mode == null ? undefined : compressModeOf(params.mode)
      if (params.mode != null && !mode) {
        throw new BridgeError('E_BAD_REQUEST', `未知的压缩方式：${String(params.mode)}`)
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
      void compressContext(params.sessionId, undefined, mode).catch(() => {})
      auditOp(
        'host.session.compress',
        params.sessionId,
        // 如实记下本次生效的方式
        `tokens=${context.tokens}${mode ? ` mode=${mode}` : ' mode=host-setting'}`,
      )
      return { ok: true as const }
    },
  }
}

/** 供 store-bridge 构造运行时 DTO（避免重复 import 面）。 */
export { toRuntimeDTO }

/**
 * 会话工作目录。从这里出而不是让 bridge/index.ts 直接 import ui/store：
 * 本文件已是「bridge 依赖 ui/store」的唯一入口。
 */
export function sessionWorkspaceOf(sessionId: string): string | null {
  return sessionStore.getSession(sessionId)?.workspace ?? null
}

/* ───────────── hello 应答的组装与拒绝文案 ───────────── */

/** 首次配对与老设备直连必须走同一函数，各拼一份只会在真机上分叉。 */
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

/** 只投影凭证本身，不回设备名与内部 id。 */
function grantOf(device: GrantRecord): GrantRecord {
  return {
    token: device.token,
    issuedAt: device.issuedAt,
    expiresAt: device.expiresAt,
    ...(device.lastSeenAt != null ? { lastSeenAt: device.lastSeenAt } : {}),
  }
}

/** 剩余天数（埋点用）。 */
function daysLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((expiresAt - now) / (24 * 60 * 60 * 1000)))
}

/** 拒绝原因 → 手机端直接显示的文案（电脑给什么手机就显示什么，避免两处漂移）。 */
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
