/**
 * 新建文档弹窗（手动输入名称 + 内容）
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { showToastMsg } from './toast'

interface Props {
  visible: boolean
  kbId: string
  onClose: () => void
  onCreated?: () => void | Promise<void>
}

export default function NewDocModal({
  visible,
  kbId,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)

  // 打开时重置表单
  useEffect(() => {
    if (visible) {
      setName('')
      setContent('')
    }
  }, [visible])

  /** 新建文档 — 手动输入名称和内容 */
  const handleNewDoc = async () => {
    if (!name.trim()) {
      showToastMsg(t('请输入文档名称'), 'error')
      return
    }
    setCreating(true)
    try {
      await ragService.writeText(kbId, name.trim(), content)
      showToastMsg(tpl('文档「$__name__」创建成功', { name: name.trim() }), 'success')
      onClose()
      setName('')
      setContent('')
      await onCreated?.()
    } catch (err: any) {
      showToastMsg(tpl('创建失败: $__error__', { error: err.message }), 'error')
    }
    setCreating(false)
  }

  return (
    <Modal
      visible={visible}
      title={t('新建文档')}
      onClose={() => {
        if (!creating) onClose()
      }}
      width={700}
      height={500}
      footer={
        <div className="kb-edit-footer">
          <ModalFooterButtons
            cancelText={t('取消')}
            confirmText={creating ? t('创建中...') : t('创建')}
            onCancel={() => {
              if (!creating) onClose()
            }}
            onConfirm={handleNewDoc}
            confirmLoading={creating}
          />
        </div>
      }>
      <div className="kb-edit-modal-body">
        <div className="kb-edit-field">
          <label className="kb-edit-label">{t('文档名称')} *</label>
          <input
            className="kb-edit-input"
            placeholder={t('请输入文档名称（如 readme.md）')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && !creating && name.trim() && handleNewDoc()
            }
            autoFocus
          />
        </div>
        <div className="kb-edit-field">
          <label className="kb-edit-label">{t('文档内容')}</label>
          <textarea
            className="kb-edit-textarea"
            placeholder={t('请输入文档内容')}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
          />
        </div>
      </div>
    </Modal>
  )
}
