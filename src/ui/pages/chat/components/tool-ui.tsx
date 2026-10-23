/**
 * 工具调用相关的 UI 状态与弹窗（封装 ChatView 里的这部分逻辑；新增交互类型在此扩展 `useToolUI`）。
 *
 * ⚠️ **两条呈现通道，一个来源**：同一个待应答交互由设置决定走哪条 ——
 *  - `modal`：跨会话弹窗 + 切换条（历史行为，`settingsState.value.{userChoiceInline,authorizationInline}` 关掉时）；
 *  - `inline`：显示在**所属会话**的消息列表下方（`inline-interactions/`），不弹窗、不闪烁提醒。
 *  `delivery` 在**入队那一刻**按设置定死：热切换不会把正在填的卡片连根拔起（草稿 / 焦点会丢）。
 *
 * ⚠️ **多交互并发**：AI 提问（`user_choice`）与授权确认（`authorization`）统一排进**一个队列**，
 * 一次只展示**一项**；队列与「当前展示项」的状态机在 `modals/pending-interactions.ts`（纯函数、可单测）。
 * 改造前两类弹窗各自维护队列、各自渲染 —— 跨类并发时两个弹窗**直接叠在一起**（后渲染的盖住先渲染的，
 * 被盖的那个既没人应答、也没人看得见，只能干等）。现在由 `modals/pending-switcher` 提示
 * 「还有几个、分别是哪个」，随时可切（先去答别的，再切回来）。
 *
 * ⚠️ **所有待应答弹窗都保持挂载**（只有当前项 `visible`）：用户切走再切回来时，表单里的草稿
 * （已勾选的选项 / 自定义输入）必须还在 —— 卸载即清空，等于让用户重填一遍。因此这里返回的是**元素**，
 * 而不是 `useCallback` 包出来的内联组件：后者每次渲染都换组件类型，React 会把全部弹窗卸载重挂，
 * 草稿同样会丢（顺带把输入焦点打飞）。
 *
 * 应答一律带 `interactionId`，工具侧据此精确路由，不匹配的应答一律忽略（见 `events/toolInteractEvent.ts`）。
 * 两条通道共用这同一套应答函数（`resolveChoice` / `allowAuth` …）：它们只认 `interactionId`，不关心是哪个壳。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import UserChoiceModal from './modals/user-choice'
import type { UserChoiceResult } from './modals/user-choice'
import AuthorizationModal from './modals/authorization'
import PendingSwitcher from './modals/pending-switcher'
import InlineInteractions from './inline-interactions'
import {
  activate,
  activeItem,
  enqueue,
  removePending,
  stepPending,
  EMPTY_PENDING_STATE,
} from './modals/pending-interactions'
import type { PendingInteraction, PendingState } from './modals/pending-interactions'
import {
  clearChoiceDraft,
  draftKey,
  getChoiceDraft,
  saveChoiceDraft,
} from './modals/choice-drafts'
import toolInteractEvent from '@/events/toolInteractEvent'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { settingsState } from '@/ui/store/settingStore'
import { track } from '@/utils/telemetry'
import { t } from '@/ui/i18n'

/** 提问类的队列项（草稿只对它有「暂存 → 恢复」的语义） */
type ChoiceItem = Extract<PendingInteraction, { kind: 'choice' }>

/** 呈现通道：弹窗（引导立即解决）/ 会话内卡片 */
type Delivery = 'modal' | 'inline'

/** 队列项 = 交互本体 + 入队时定死的通道（`pending-interactions.ts` 的纯函数不认识它，故用交叉类型） */
type QueuedInteraction = PendingInteraction & { delivery: Delivery }

interface ToolUIQueue {
  /** 走弹窗的那部分：现有状态机原样复用（切换条 / 未读 / `Alt+←→` 全在它上面） */
  modal: PendingState
  /** 走会话内的那部分：按到达顺序，渲染时按 `sessionId` 过滤 */
  inline: QueuedInteraction[]
}

const EMPTY_QUEUE: ToolUIQueue = { modal: EMPTY_PENDING_STATE, inline: [] }

/** 入队（同一个 interactionId 幂等：事件重放 / 手机端推回都不该多出一份） */
function push(queue: ToolUIQueue, item: QueuedInteraction): ToolUIQueue {
  if (item.delivery === 'inline') {
    if (queue.inline.some((i) => i.interactionId === item.interactionId)) {
      return queue
    }
    return { ...queue, inline: [...queue.inline, item] }
  }
  const modal = enqueue(queue.modal, item)
  return modal === queue.modal ? queue : { ...queue, modal }
}

/** 出队（两条通道都摘：另一个应答端 / 运行结束收敛都走这里，幂等） */
function drop(queue: ToolUIQueue, interactionId: string): ToolUIQueue {
  const modal = removePending(queue.modal, interactionId)
  const inline = queue.inline.filter((i) => i.interactionId !== interactionId)
  if (modal === queue.modal && inline.length === queue.inline.length) return queue
  return { modal, inline }
}

function findItem(
  queue: ToolUIQueue,
  interactionId: string,
): PendingInteraction | undefined {
  return (
    queue.modal.items.find((i) => i.interactionId === interactionId) ??
    queue.inline.find((i) => i.interactionId === interactionId)
  )
}

/**
 * 提问的草稿键。用 `sessionId|toolCallId`：暂存 ↔ 恢复之间 toolCallId 稳定（Rust 快照存的就是它），
 * 而 interactionId 每次都换 —— 不能拿它当键，否则恢复后找不到草稿。
 */
function choiceDraftKeyOf(item: PendingInteraction): string {
  return draftKey(item.sessionId, item.toolCallId)
}

export function useToolUI() {
  const [queue, setQueue] = useState<ToolUIQueue>(EMPTY_QUEUE)
  /** 供「只注册一次」的回调读取最新队列（settled 要按 id 找到 item 才能清草稿） */
  const queueRef = useRef(queue)
  queueRef.current = queue

  // 监听 user_choice
  useEffect(() => {
    const off = toolInteractEvent.on('showChoice', (payload) => {
      const mode: Delivery = settingsState.value.userChoiceInline
        ? 'inline'
        : 'modal'
      setQueue((q) => push(q, { ...payload, kind: 'choice', delivery: mode }))
      track('interaction.presented', {
        kind: 'choice',
        mode,
        session_id: payload.sessionId,
      })
      // 只有「立即解决」那一类才闪烁 / 置前 —— 会话内卡片按定义不打断用户
      if (mode === 'modal') {
        // AI 调用 user_choice → 窗口未激活时闪烁提醒；隐藏到托盘时必须先显示出来
        // （否则弹窗没人看见，引擎会因等回执而挂死）
        void requestAttentionIfUnfocused(
          undefined,
          settingsState.value.forceWindowActive,
          true,
        )
      }
    })
    return off
  }, [])

  // 监听 authorization（通用授权确认）
  useEffect(() => {
    const off = toolInteractEvent.on('showAuthorization', (payload) => {
      const mode: Delivery = settingsState.value.authorizationInline
        ? 'inline'
        : 'modal'
      setQueue((q) =>
        push(q, { ...payload, kind: 'authorization', delivery: mode }),
      )
      track('interaction.presented', {
        kind: 'authorization',
        mode,
        session_id: payload.sessionId,
      })
      if (mode === 'modal') {
        // 授权确认弹窗 → 窗口未激活时闪烁提醒（与 user_choice 一致）
        // ensureVisible：隐藏到托盘时先显示窗口，否则确认弹窗无人应答 → 引擎挂死
        void requestAttentionIfUnfocused(
          undefined,
          settingsState.value.forceWindowActive,
          true,
        )
      }
    })
    return off
  }, [])

  /**
   * 交互已被应答 —— 出队（自己应答时也在同一次事件里出队，这里是幂等空操作）。
   * **另一个应答端**（手机 / 另一个窗口）应答时靠这里收掉桌面上的卡片，否则会看到「已经批过的弹窗还挂着」，
   * 再点一次就是对同一个交互重复应答。
   */
  useEffect(() => {
    const off = toolInteractEvent.on(
      'interactionSettled',
      (interactionId, outcome) => {
        const item = findItem(queueRef.current, interactionId)
        // 草稿只在**暂存**时保留：那是唯一「之后还会再问一次同一个问题」的终态
        //（应答 / 取消 / 运行结束收敛之后都不会再问，留着只是垃圾）。
        if (item?.kind === 'choice' && outcome !== 'shelve') {
          clearChoiceDraft(choiceDraftKeyOf(item))
        }
        setQueue((q) => drop(q, interactionId))
      },
    )
    return off
  }, [])

  /** 当前展示项（`activeId` 失效时退回队首，保证「有队列就有弹窗」） */
  const current = activeItem(queue.modal)

  /** 切换待处理项（切换条点击） */
  const handleSwitch = useCallback((interactionId: string) => {
    setQueue((q) => {
      const modal = activate(q.modal, interactionId)
      return modal === q.modal ? q : { ...q, modal }
    })
  }, [])

  /**
   * `Alt + ←/→` 在待处理项之间切换（弹窗自身的键盘约定不带 modifier，这里刻意错开：
   * 两边都挂在 document / backdrop 上，不带修饰键会互相抢）。
   * ⚠️ 焦点在输入框里时不接管：macOS / Windows 上 Alt(Option)+←→ 是「按词移动光标」，
   * 抢掉等于把用户的输入手感弄坏 —— 打字时不切窗，先切走焦点再切（弹窗内点一下空白即可）。
   * ⚠️ 弹窗侧的键盘处理同样要跳过带修饰键的组合（见 modals/user-choice、modals/authorization）。
   * 会话内卡片不参与（它们在各自会话里按到达顺序排着，没有「切到哪一个」的问题）。
   */
  useEffect(() => {
    if (queue.modal.items.length < 2) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const delta =
        e.key === 'ArrowRight' || e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : 0
      if (delta === 0) return
      const active = document.activeElement as HTMLElement | null
      if (
        active &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      ) {
        return
      }
      e.preventDefault()
      setQueue((q) => {
        const modal = stepPending(
          q.modal,
          delta,
          activeItem(q.modal)?.interactionId ?? null,
        )
        return modal === q.modal ? q : { ...q, modal }
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [queue.modal.items.length])

  // ── 应答：一律按 interactionId 精确路由（不再假设「正在答的就是队首」——用户可以切着答） ──

  const resolveChoice = useCallback(
    (interactionId: string, result: UserChoiceResult) => {
      const item = findItem(queueRef.current, interactionId)
      // 已应答 → 草稿没用了（settled 广播里还会再清一次，幂等）
      if (item?.kind === 'choice') clearChoiceDraft(choiceDraftKeyOf(item))
      setQueue((q) => drop(q, interactionId))
      // 构建给 AI 的 content 字符串
      const parts: string[] = []
      if (result.selected.length > 0) {
        parts.push(result.selected.join(', '))
      }
      if (result.customReply) {
        parts.push(result.customReply)
      }
      const content = parts.join(t('；'))
      // uiData 携带结构化数据供 UserChoiceMessage 展示
      toolInteractEvent.emit('resolve', interactionId, { content, uiData: result })
    },
    [],
  )
  const shelveChoice = useCallback((interactionId: string) => {
    setQueue((q) => drop(q, interactionId))
    toolInteractEvent.emit(
      'reject',
      interactionId,
      'shelve:' + t('用户暂存了这个问题'),
    )
  }, [])
  const cancelChoice = useCallback((interactionId: string) => {
    const item = findItem(queueRef.current, interactionId)
    // 取消 = 放弃这个问题（引擎收到 cancelled 后不会再问）→ 草稿一并清掉
    if (item?.kind === 'choice') clearChoiceDraft(choiceDraftKeyOf(item))
    setQueue((q) => drop(q, interactionId))
    toolInteractEvent.emit('reject', interactionId, t('用户关闭了选择弹窗'))
  }, [])

  const allowAuth = useCallback((interactionId: string) => {
    setQueue((q) => drop(q, interactionId))
    toolInteractEvent.emit('commandResolve', interactionId, '')
  }, [])
  const shelveAuth = useCallback((interactionId: string) => {
    setQueue((q) => drop(q, interactionId))
    toolInteractEvent.emit(
      'commandReject',
      interactionId,
      'shelve:' + t('用户暂存了该命令'),
    )
  }, [])
  const denyAuth = useCallback((interactionId: string) => {
    setQueue((q) => drop(q, interactionId))
    toolInteractEvent.emit('commandReject', interactionId, t('用户拒绝了该命令'))
  }, [])

  // 队列里**每一项都渲染**，但只有当前项可见（`visible=false` 的弹窗返回 null、不占 DOM）——
  // 这样切走再切回来，各自表单里的草稿还在。
  const toolUI = (
    <>
      <PendingSwitcher
        items={queue.modal.items}
        activeId={current?.interactionId ?? null}
        unread={queue.modal.unread}
        onSwitch={handleSwitch}
      />
      {queue.modal.items.map((item) =>
        item.kind === 'choice' ? (
          <UserChoiceModal
            key={item.interactionId}
            visible={item.interactionId === current?.interactionId}
            sessionId={item.sessionId}
            question={item.question}
            options={item.options}
            multi={item.multi}
            // 草稿：暂存 → 恢复（新 interactionId、新实例、同一个 toolCallId）时把上次填的带回来
            initialDraft={getChoiceDraft(choiceDraftKeyOf(item))}
            onDraftChange={(draft) =>
              saveChoiceDraft(choiceDraftKeyOf(item), draft)
            }
            onConfirm={(result) => resolveChoice(item.interactionId, result)}
            onCancel={() => cancelChoice(item.interactionId)}
            onShelve={() => shelveChoice(item.interactionId)}
          />
        ) : (
          <AuthorizationModal
            key={item.interactionId}
            visible={item.interactionId === current?.interactionId}
            permName={item.permName}
            title={item.title}
            subTitle={item.subTitle}
            desc={item.desc}
            command={item.command}
            hint={item.hint}
            risk={item.risk}
            onConfirm={() => allowAuth(item.interactionId)}
            onCancel={() => denyAuth(item.interactionId)}
            onShelve={() => shelveAuth(item.interactionId)}
          />
        ),
      )}
    </>
  )

  /** 会话内的那部分（只显示当前会话的，见组件内部过滤） */
  const inlineUI = (
    <InlineInteractions
      items={queue.inline}
      onResolveChoice={resolveChoice}
      onCancelChoice={cancelChoice}
      onAllowAuth={allowAuth}
      onDenyAuth={denyAuth}
    />
  )

  return { toolUI, inlineUI }
}
