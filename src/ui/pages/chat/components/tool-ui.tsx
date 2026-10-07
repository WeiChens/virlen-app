/**
 * 工具调用相关的 UI 状态与弹窗（封装 ChatView 里的这部分逻辑；新增交互类型在此扩展 `useToolUI`）。
 *
 * ⚠️ **多交互并发**：每种弹窗各维护一个**待应答队列**，一次只展示队首，应答后自动轮到下一个。改造前是
 * 单对象 state —— 后到的请求直接覆盖前一个，而前一个既没被应答、也无法再展示，引擎只能挂死在等回执上。
 *
 * 应答一律带 `interactionId`，工具侧据此精确路由，不匹配的应答一律忽略（见 `events/toolInteractEvent.ts`）。
 */
import { useState, useEffect, useCallback } from 'react'
import UserChoiceModal from './modals/user-choice'
import type { UserChoiceResult } from './modals/user-choice'
import AuthorizationModal from './modals/authorization'
import toolInteractEvent from '@/events/toolInteractEvent'
import type {
  ChoiceRequest,
  AuthorizationRequest,
} from '@/events/toolInteractEvent'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { settingsState } from '@/ui/store/settingStore'
import { t } from '@/ui/i18n'

// UserChoice

type ChoiceModalState = { visible: boolean } & ChoiceRequest

const defaultChoice: ChoiceModalState = {
  visible: false,
  interactionId: '',
  sessionId: '',
  toolCallId: '',
  question: '',
  options: [],
  multi: false,
}

// Authorization（通用授权确认，弹窗见 modals/authorization）

type AuthorizationState = { visible: boolean } & AuthorizationRequest

const defaultAuthorization: AuthorizationState = {
  visible: false,
  interactionId: '',
  sessionId: '',
  toolCallId: '',
  permName: '',
  title: '',
  subTitle: '',
  desc: '',
  command: '',
  hint: '',
  risk: '',
}

/**
 * 从队列里剔除指定交互。
 * 不存在时**原样返回同一个引用** —— 否则每次 `interactionSettled` 都会触发无意义的重渲染。
 */
function dropById<T extends { interactionId: string }>(
  queue: T[],
  interactionId: string,
): T[] {
  return queue.some((x) => x.interactionId === interactionId)
    ? queue.filter((x) => x.interactionId !== interactionId)
    : queue
}

export function useToolUI() {
  const [choiceQueue, setChoiceQueue] = useState<ChoiceModalState[]>([])
  const [authQueue, setAuthQueue] = useState<AuthorizationState[]>([])

  /** 当前展示的交互 = 队首（应答出队后自动轮到下一个） */
  const choiceModal = choiceQueue[0] ?? defaultChoice
  const authModal = authQueue[0] ?? defaultAuthorization

  // 监听 user_choice
  useEffect(() => {
    const off = toolInteractEvent.on('showChoice', (payload) => {
      setChoiceQueue((q) => [...q, { ...payload, visible: true }])
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
      setAuthQueue((q) => [...q, { ...payload, visible: true }])
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
   * 交互已被应答 —— 从队列里摘掉它（自己应答时已出队，这里是幂等空操作）。
   * **另一个应答端**（手机 / 另一个窗口）应答时靠这里收掉桌面上的弹窗，否则会看到「已经批过的弹窗还挂着」，
   * 再点一次就是对同一个交互重复应答。
   */
  useEffect(() => {
    const off = toolInteractEvent.on('interactionSettled', (interactionId) => {
      setChoiceQueue((q) => dropById(q, interactionId))
      setAuthQueue((q) => dropById(q, interactionId))
    })
    return off
  }, [])

  // UserChoice 回调
  const handleChoiceConfirm = useCallback(
    (result: UserChoiceResult) => {
      const current = choiceQueue[0]
      if (!current) return
      setChoiceQueue((q) => q.slice(1))
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
      toolInteractEvent.emit('resolve', current.interactionId, {
        content,
        uiData: result,
      })
    },
    [choiceQueue],
  )
  const handleChoiceShelve = useCallback(() => {
    const current = choiceQueue[0]
    if (!current) return
    setChoiceQueue((q) => q.slice(1))
    toolInteractEvent.emit(
      'reject',
      current.interactionId,
      'shelve:' + t('用户暂存了这个问题'),
    )
  }, [choiceQueue])
  const handleChoiceCancel = useCallback(() => {
    const current = choiceQueue[0]
    if (!current) return
    setChoiceQueue((q) => q.slice(1))
    toolInteractEvent.emit(
      'reject',
      current.interactionId,
      t('用户关闭了选择弹窗'),
    )
  }, [choiceQueue])

  const handleAuthAllow = useCallback(() => {
    const current = authQueue[0]
    if (!current) return
    setAuthQueue((q) => q.slice(1))
    toolInteractEvent.emit('commandResolve', current.interactionId, '')
  }, [authQueue])
  const handleAuthShelve = useCallback(() => {
    const current = authQueue[0]
    if (!current) return
    setAuthQueue((q) => q.slice(1))
    toolInteractEvent.emit(
      'commandReject',
      current.interactionId,
      'shelve:' + t('用户暂存了该命令'),
    )
  }, [authQueue])
  const handleAuthCancel = useCallback(() => {
    const current = authQueue[0]
    if (!current) return
    setAuthQueue((q) => q.slice(1))
    toolInteractEvent.emit(
      'commandReject',
      current.interactionId,
      t('用户拒绝了该命令'),
    )
  }, [authQueue])

  const ToolUI = useCallback(
    () => (
      <>
        <UserChoiceModal
          visible={choiceModal.visible}
          sessionId={choiceModal.sessionId}
          question={choiceModal.question}
          options={choiceModal.options}
          multi={choiceModal.multi}
          onConfirm={handleChoiceConfirm}
          onCancel={handleChoiceCancel}
          onShelve={handleChoiceShelve}
        />
        <AuthorizationModal
          visible={authModal.visible}
          permName={authModal.permName}
          title={authModal.title}
          subTitle={authModal.subTitle}
          desc={authModal.desc}
          command={authModal.command}
          hint={authModal.hint}
          risk={authModal.risk}
          onConfirm={handleAuthAllow}
          onCancel={handleAuthCancel}
          onShelve={handleAuthShelve}
        />
      </>
    ),
    [
      choiceModal,
      authModal,
      handleChoiceConfirm,
      handleChoiceShelve,
      handleChoiceCancel,
      handleAuthAllow,
      handleAuthShelve,
      handleAuthCancel,
    ],
  )

  return { ToolUI }
}
