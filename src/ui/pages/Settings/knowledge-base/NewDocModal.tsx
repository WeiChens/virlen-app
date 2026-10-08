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

  /** 新建文档 — 直接写名字和内容（不必先在电脑上建一个文件） */
  const handleNewDoc = async () => {
    if (!name.trim()) {
      showToastMsg(t('先给这份文档起个名字'), 'error')
      return
    }
    setCreating(true)
    try {
      await ragService.writeText(kbId, name.trim(), content)
      showToastMsg(tpl('已保存「$__name__」', { name: name.trim() }), 'success')
      onClose()
      setName('')
      setContent('')
      await onCreated?.()
    } catch (err: any) {
      showToastMsg(tpl('保存失败：$__error__', { error: err.message }), 'error')
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
            confirmText={creating ? t('保存中…') : t('保存')}
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
          <label className="kb-edit-label">{t('文档名字')} *</label>
          <input
            className="kb-edit-input"
            placeholder={t('例如：常见问题.md')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && !creating && name.trim() && handleNewDoc()
            }
            autoFocus
          />
        </div>
        <div className="kb-edit-field">
          <label className="kb-edit-label">{t('内容')}</label>
          <textarea
            className="kb-edit-textarea"
            placeholder={t('把内容粘贴或写在这里')}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
          />
        </div>
      </div>
    </Modal>
  )
}
