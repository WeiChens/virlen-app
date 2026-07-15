/**
 * ExportDialog — 会话导出选项弹窗
 *
 * 让用户在导出前选择：
 *  - 是否省略工具调用信息
 *  - 是否省略思考文本
 */
import { useState } from 'react'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import type { ExportOptions } from '@/services/export-service'
import { t } from '@/ui/i18n'
import './export-dialog.scss'

interface Props {
  visible: boolean
  sessionTitle: string
  onConfirm: (options: ExportOptions) => void
  onCancel: () => void
}

export default function ExportDialog({
  visible,
  sessionTitle,
  onConfirm,
  onCancel,
}: Props) {
  const [omitToolCalls, setOmitToolCalls] = useState(false)
  const [omitThinking, setOmitThinking] = useState(false)

  function handleConfirm() {
    onConfirm({ omitToolCalls, omitThinking })
  }

  return (
    <Modal
      visible={visible}
      title={t('导出会话')}
      onClose={onCancel}
      footer={
        <ModalFooterButtons
          onCancel={onCancel}
          onConfirm={handleConfirm}
          confirmText={t('导出')}
        />
      }>
      <div className="export-dialog-body">
        <p className="export-dialog-hint">
          {t('将会话「')}
          <strong>{sessionTitle}</strong>
          {t('」导出为 Markdown 文件')}
        </p>

        <label className="export-option">
          <input
            type="checkbox"
            checked={omitToolCalls}
            onChange={(e) => setOmitToolCalls(e.target.checked)}
          />
          <span className="export-option-text">{t('省略工具调用信息')}</span>
          <span className="export-option-desc">
            {t('不包含工具调用参数和返回结果')}
          </span>
        </label>

        <label className="export-option">
          <input
            type="checkbox"
            checked={omitThinking}
            onChange={(e) => setOmitThinking(e.target.checked)}
          />
          <span className="export-option-text">{t('省略思考文本')}</span>
          <span className="export-option-desc">
            {t('不包含模型的思考过程（reasoning content）')}
          </span>
        </label>
      </div>
    </Modal>
  )
}
