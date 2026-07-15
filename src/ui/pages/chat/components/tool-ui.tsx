/**
 * tool-ui — 工具调用相关的 UI 状态与弹窗
 *
 * 封装 ChatView 中与 tool 调用相关的 UI 逻辑。
 * 新增交互类型时在此扩展 useToolUI 即可。
 */
import { useState, useEffect, useCallback } from 'react'
import UserChoiceModal from './modals/user-choice'
import CommandConfirmModal from './modals/command-confirm'
import toolInteractEvent from '@/events/toolInteractEvent'

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

// ====== CommandConfirm ======

type CommandConfirmState = {
  visible: boolean
  sessionId: string
  command: string
  risk: string
  label: string
  hint: string
}

const defaultConfirm: CommandConfirmState = {
  visible: false,
  sessionId: '',
  command: '',
  risk: '',
  label: '',
  hint: '',
}

export function useToolUI() {
  const [choiceModal, setChoiceModal] =
    useState<ChoiceModalState>(defaultChoice)
  const [confirmModal, setConfirmModal] =
    useState<CommandConfirmState>(defaultConfirm)

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
      },
    )
    return off
  }, [])

  // 监听 command_confirm
  useEffect(() => {
    const off = toolInteractEvent.on(
      'showCommandConfirm',
      (sessionId, command, risk, label, hint) => {
        setConfirmModal({
          visible: true,
          sessionId,
          command,
          risk,
          label,
          hint,
        })
      },
    )
    return off
  }, [])

  // ====== UserChoice 回调 ======
  const handleChoiceConfirm = useCallback((selected: string | string[]) => {
    setChoiceModal(defaultChoice)
    const result = Array.isArray(selected) ? selected.join(', ') : selected
    toolInteractEvent.emit('resolve', result)
  }, [])
  const handleChoiceShelve = useCallback(() => {
    setChoiceModal(defaultChoice)
    toolInteractEvent.emit('reject', 'shelve:用户暂存了这个问题')
  }, [])
  const handleChoiceCancel = useCallback(() => {
    setChoiceModal(defaultChoice)
    toolInteractEvent.emit('reject', '用户关闭了选择弹窗')
  }, [])

  const handleConfirmAllow = useCallback(() => {
    setConfirmModal(defaultConfirm)
    toolInteractEvent.emit('commandResolve', '')
  }, [])
  const handleConfirmShelve = useCallback(() => {
    setConfirmModal(defaultConfirm)
    toolInteractEvent.emit('commandReject', 'shelve:用户暂存了该命令')
  }, [])
  const handleConfirmCancel = useCallback(() => {
    setConfirmModal(defaultConfirm)
    toolInteractEvent.emit('commandReject', '用户拒绝了该命令')
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
        <CommandConfirmModal
          visible={confirmModal.visible}
          sessionId={confirmModal.sessionId}
          command={confirmModal.command}
          risk={confirmModal.risk}
          label={confirmModal.label}
          hint={confirmModal.hint}
          onConfirm={handleConfirmAllow}
          onCancel={handleConfirmCancel}
          onShelve={handleConfirmShelve}
        />
      </>
    ),
    [
      choiceModal,
      confirmModal,
      handleChoiceConfirm,
      handleChoiceShelve,
      handleChoiceCancel,
      handleConfirmAllow,
      handleConfirmShelve,
      handleConfirmCancel,
    ],
  )

  return { ToolUI }
}
