/**
 * tool-ui — 工具调用相关的 UI 状态与弹窗
 *
 * 封装 ChatView 中与 tool 调用相关的 UI 逻辑。
 * 新增交互类型时在此扩展 useToolUI 即可。
 */
import { useState, useEffect, useCallback } from 'react'
import UserChoiceModal from './modals/user-choice'
import type { UserChoiceResult } from './modals/user-choice'
import AuthorizationModal from './modals/authorization'
import toolInteractEvent from '@/events/toolInteractEvent'
import type { AuthorizationRequest } from '@/events/toolInteractEvent'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { settingsState } from '@/ui/store/settingStore'
import { t } from '@/ui/i18n'

// ====== UserChoice ======

type ChoiceModalState = {
  visible: boolean
  sessionId: string
  question: string
  options: string[]
  multi: boolean
}

const defaultChoice: ChoiceModalState = {
  visible: false,
  sessionId: '1',
  question: ``,
  options: [],
  multi: false,
}

// ====== Authorization（通用授权确认，弹窗见 modals/authorization）======

type AuthorizationState = { visible: boolean } & AuthorizationRequest

const defaultAuthorization: AuthorizationState = {
  visible: false,
  permName: '',
  title: '',
  subTitle: '',
  desc: '',
  command: '',
  hint: '',
  risk: '',
}

export function useToolUI() {
  const [choiceModal, setChoiceModal] =
    useState<ChoiceModalState>(defaultChoice)
  const [authModal, setAuthModal] =
    useState<AuthorizationState>(defaultAuthorization)

  // 监听 user_choice
  useEffect(() => {
    const off = toolInteractEvent.on(
      'showChoice',
      (sessionId, question, options, multi) => {
        setChoiceModal({
          visible: true,
          sessionId,
          question,
          options,
          multi,
        })
        // AI 调用 user_choice（用户选择）→ 窗口未激活时闪烁提醒
        void requestAttentionIfUnfocused(
          undefined,
          settingsState.value.forceWindowActive,
        )
      },
    )
    return off
  }, [])

  // 监听 authorization（通用授权确认）
  useEffect(() => {
    const off = toolInteractEvent.on('showAuthorization', (payload) => {
      setAuthModal({ visible: true, ...payload })
      // 授权确认弹窗出现 → 窗口未激活时闪烁提醒
      // （与 user_choice / AI 回复结束保持一致：都要用户立刻注意）
      void requestAttentionIfUnfocused(
        undefined,
        settingsState.value.forceWindowActive,
      )
    })
    return off
  }, [])

  // ====== UserChoice 回调 ======
  const handleChoiceConfirm = useCallback((result: UserChoiceResult) => {
    setChoiceModal(defaultChoice)
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
    toolInteractEvent.emit('resolve', { content, uiData: result })
  }, [])
  const handleChoiceShelve = useCallback(() => {
    setChoiceModal(defaultChoice)
    toolInteractEvent.emit('reject', 'shelve:' + t('用户暂存了这个问题'))
  }, [])
  const handleChoiceCancel = useCallback(() => {
    setChoiceModal(defaultChoice)
    toolInteractEvent.emit('reject', t('用户关闭了选择弹窗'))
  }, [])

  const handleAuthAllow = useCallback(() => {
    setAuthModal(defaultAuthorization)
    toolInteractEvent.emit('commandResolve', '')
  }, [])
  const handleAuthShelve = useCallback(() => {
    setAuthModal(defaultAuthorization)
    toolInteractEvent.emit('commandReject', 'shelve:' + t('用户暂存了该命令'))
  }, [])
  const handleAuthCancel = useCallback(() => {
    setAuthModal(defaultAuthorization)
    toolInteractEvent.emit('commandReject', t('用户拒绝了该命令'))
  }, [])

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
