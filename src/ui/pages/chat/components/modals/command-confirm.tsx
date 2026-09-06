/**
 * CommandConfirmModal — AI 执行高危/安装命令前，用户确认弹窗
 */
import Modal from '@/ui/components/shared/Modal'
import './command-confirm.scss'

interface Props {
  visible: boolean
  sessionId: string
  command: string
  risk: string
  label: string
  hint: string
  /** AI 给出的命令作用说明（展示在弹窗中，帮助用户判断） */
  tips?: string
  onConfirm: () => void
  onCancel: () => void
  onShelve: () => void
}

export default function CommandConfirmModal({
  visible,
  command,
  risk,
  label,
  hint,
  tips,
  onConfirm,
  onCancel,
  onShelve,
}: Props) {
  return (
    <Modal
      visible={visible}
      onClose={onCancel}
      title="命令执行确认"
      width={520}>
      <div className="command-confirm">
        <div className={`risk-badge ${risk}`}>{label}</div>
        {tips && <p className="tips-text">{tips}</p>}
        <p className="hint-text">{hint}</p>
        <div className="command-preview">
          <code>{command}</code>
        </div>
        <div className="actions">
          <button className="btn-shelve" onClick={onShelve}>
            暂存
          </button>
          <button className="btn-cancel" onClick={onCancel}>
            拒绝
          </button>
          <button className="btn-confirm" onClick={onConfirm}>
            允许执行
          </button>
        </div>
      </div>
    </Modal>
  )
}
