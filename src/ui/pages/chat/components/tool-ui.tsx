/**
 * 工具调用相关的 UI 状态与弹窗（封装 ChatView 里的这部分逻辑；新增交互类型在此扩展 `useToolUI`）。
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
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import UserChoiceModal from './modals/user-choice'
import type { UserChoiceResult } from './modals/user-choice'
import AuthorizationModal from './modals/authorization'
import PendingSwitcher from './modals/pending-switcher'
import {
  activate,
  activeItem,
  enqueue,
  removePending,
  stepPending,
  EMPTY_PENDING_STATE,
} from './modals/pending-interactions'
import type { PendingInteraction } from './modals/pending-interactions'
import {
  clearChoiceDraft,
  draftKey,
  getChoiceDraft,
  saveChoiceDraft,
} from './modals/choice-drafts'
import toolInteractEvent from '@/events/toolInteractEvent'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { settingsState } from '@/ui/store/settingStore'
import { t } from '@/ui/i18n'

/** 提问类的队列项（草稿只对它有「暂存 → 恢复」的语义） */
type ChoiceItem = Extract<PendingInteraction, { kind: 'choice' }>

/**
 * 提问的草稿键。用 `sessionId|toolCallId`：暂存 ↔ 恢复之间 toolCallId 稳定（Rust 快照存的就是它），
 * 而 interactionId 每次都换 —— 不能拿它当键，否则恢复后找不到草稿。
 */
function choiceDraftKeyOf(item: ChoiceItem): string {
  return draftKey(item.sessionId, item.toolCallId)
}

export function useToolUI() {
  const [pending, setPending] = useState(EMPTY_PENDING_STATE)
  /** 供「只注册一次」的事件回调读取最新队列（settled 要按 id 找到 item 才能清草稿） */
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  // 监听 user_choice
  useEffect(() => {
    const off = toolInteractEvent.on('showChoice', (payload) => {
      setPending((s) => enqueue(s, { ...payload, kind: 'choice' }))
      // AI 调用 user_choice → 窗口未激活时闪烁提醒；隐藏到托盘时必须先显示出来
      // （否则弹窗没人看见，引擎会因等回执而挂死）
      void requestAttentionIfUnfocused(
        undefined,
        settingsState.value.forceWindowActive,
        true,
      )
    })
    return off
  }, [])

  // 监听 authorization（通用授权确认）
  useEffect(() => {
    const off = toolInteractEvent.on('showAuthorization', (payload) => {
      setPending((s) => enqueue(s, { ...payload, kind: 'authorization' }))
      // 授权确认弹窗 → 窗口未激活时闪烁提醒（与 user_choice 一致）
      // ensureVisible：隐藏到托盘时先显示窗口，否则确认弹窗无人应答 → 引擎挂死
      void requestAttentionIfUnfocused(
        undefined,
        settingsState.value.forceWindowActive,
        true,
      )
    })
    return off
  }, [])

  /**
   * 交互已被应答 —— 出队（自己应答时也在同一次事件里出队，这里是幂等空操作）。
   * **另一个应答端**（手机 / 另一个窗口）应答时靠这里收掉桌面上的弹窗，否则会看到「已经批过的弹窗还挂着」，
   * 再点一次就是对同一个交互重复应答。
   */
  useEffect(() => {
    const off = toolInteractEvent.on(
      'interactionSettled',
      (interactionId, outcome) => {
        const item = pendingRef.current.items.find(
          (i) => i.interactionId === interactionId,
        )
        // 草稿只在**暂存**时保留：那是唯一「之后还会再问一次同一个问题」的终态
        //（应答 / 取消 / 运行结束收敛之后都不会再问，留着只是垃圾）。
        if (item?.kind === 'choice' && outcome !== 'shelve') {
          clearChoiceDraft(choiceDraftKeyOf(item))
        }
        setPending((s) => removePending(s, interactionId))
      },
    )
    return off
  }, [])

  /** 当前展示项（`activeId` 失效时退回队首，保证「有队列就有弹窗」） */
  const current = activeItem(pending)

  /** 切换待处理项（切换条点击） */
  const handleSwitch = useCallback((interactionId: string) => {
    setPending((s) => activate(s, interactionId))
  }, [])

  /**
   * `Alt + ←/→` 在待处理项之间切换（弹窗自身的键盘约定不带 modifier，这里刻意错开：
   * 两边都挂在 document / backdrop 上，不带修饰键会互相抢）。
   * ⚠️ 焦点在输入框里时不接管：macOS / Windows 上 Alt(Option)+←→ 是「按词移动光标」，
   * 抢掉等于把用户的输入手感弄坏 —— 打字时不切窗，先切走焦点再切（弹窗内点一下空白即可）。
   * ⚠️ 弹窗侧的键盘处理同样要跳过带修饰键的组合（见 modals/user-choice、modals/authorization）。
   */
  useEffect(() => {
    if (pending.items.length < 2) return
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
      setPending((s) => stepPending(s, delta, activeItem(s)?.interactionId ?? null))
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [pending.items.length])

  // ── 应答：一律按 interactionId 精确路由（不再假设「正在答的就是队首」——用户可以切着答） ──

  const resolveChoice = useCallback(
    (interactionId: string, result: UserChoiceResult) => {
      const item = pendingRef.current.items.find(
        (i) => i.interactionId === interactionId,
      )
      // 已应答 → 草稿没用了（settled 广播里还会再清一次，幂等）
      if (item?.kind === 'choice') clearChoiceDraft(choiceDraftKeyOf(item))
      setPending((s) => removePending(s, interactionId))
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
    setPending((s) => removePending(s, interactionId))
    toolInteractEvent.emit(
      'reject',
      interactionId,
      'shelve:' + t('用户暂存了这个问题'),
    )
  }, [])
  const cancelChoice = useCallback((interactionId: string) => {
    const item = pendingRef.current.items.find(
      (i) => i.interactionId === interactionId,
    )
    // 取消 = 放弃这个问题（引擎收到 cancelled 后不会再问）→ 草稿一并清掉
    if (item?.kind === 'choice') clearChoiceDraft(choiceDraftKeyOf(item))
    setPending((s) => removePending(s, interactionId))
    toolInteractEvent.emit('reject', interactionId, t('用户关闭了选择弹窗'))
  }, [])

  const allowAuth = useCallback((interactionId: string) => {
    setPending((s) => removePending(s, interactionId))
    toolInteractEvent.emit('commandResolve', interactionId, '')
  }, [])
  const shelveAuth = useCallback((interactionId: string) => {
    setPending((s) => removePending(s, interactionId))
    toolInteractEvent.emit(
      'commandReject',
      interactionId,
      'shelve:' + t('用户暂存了该命令'),
    )
  }, [])
  const denyAuth = useCallback((interactionId: string) => {
    setPending((s) => removePending(s, interactionId))
    toolInteractEvent.emit('commandReject', interactionId, t('用户拒绝了该命令'))
  }, [])

  // 队列里**每一项都渲染**，但只有当前项可见（`visible=false` 的弹窗返回 null、不占 DOM）——
  // 这样切走再切回来，各自表单里的草稿还在。
  const toolUI = (
    <>
      <PendingSwitcher
        items={pending.items}
        activeId={current?.interactionId ?? null}
        unread={pending.unread}
        onSwitch={handleSwitch}
      />
      {pending.items.map((item) =>
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

  return { toolUI }
}
