/**
 * 新建文档弹窗（手动输入名称 + 内容）
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { showToast } from '@/ui/components/shared/Toast'

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

  /**
   * 新建文档 — 直接写名字和内容（不必先在电脑上建一个文件）
   *
   * 内容不能为空：后端 `parse_text` + 分块对空文本会直接报错「文本内容为空」，
   * 而把后端的中文提示直接丢给用户看不出是哪一步的事 —— 在这里先拦下来说清楚。
   */
  const handleNewDoc = async () => {
    if (!name.trim()) {
      showToast(t('先给这份文档起个名字'), 3000)
      return
    }
    if (!content.trim()) {
      showToast(t('先写点内容（空文档存不进知识库）'), 3000)
      return
    }
    setCreating(true)
    try {
      await ragService.writeText(kbId, name.trim(), content)
      showToast(tpl('已保存「$__name__」', { name: name.trim() }))
      onClose()
      setName('')
      setContent('')
      await onCreated?.()
    } catch (err: any) {
      showToast(tpl('保存失败：$__error__', { error: err.message }), 3000)
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
              e.key === 'Enter' &&
              !creating &&
              name.trim() &&
              content.trim() &&
              handleNewDoc()
            }
            autoFocus
          />
        </div>
        <div className="kb-edit-field">
          <label className="kb-edit-label">{t('内容')} *</label>
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
