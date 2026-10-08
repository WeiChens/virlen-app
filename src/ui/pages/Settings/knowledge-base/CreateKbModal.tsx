/**
 * 创建知识库弹窗
 *
 * 自持表单 state（名称 / 描述 / 提交中），打开时重置；
 * 创建成功后关闭并回调 onCreated（父级刷新知识库列表）。
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { showToastMsg } from './toast'

interface Props {
  visible: boolean
  onClose: () => void
  onCreated?: () => void | Promise<void>
}

export default function CreateKbModal({ visible, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [creating, setCreating] = useState(false)

  // 打开时重置表单（对齐原 openCreateModal 的字段重置）
  useEffect(() => {
    if (visible) {
      setName('')
      setDesc('')
    }
  }, [visible])

  /** 创建知识库 */
  const handleCreate = async () => {
    if (!name.trim()) {
      showToastMsg(t('先给知识库起个名字'), 'error')
      return
    }
    setCreating(true)
    try {
      await ragService.createKnowledgeBase(name.trim(), desc.trim())
      showToastMsg(
        tpl('已新建知识库「$__name__」，接下来把文档加进去', { name: name.trim() }),
        'success',
      )
      onClose()
      setName('')
      setDesc('')
      await onCreated?.()
    } catch (err: any) {
      showToastMsg(tpl('创建失败：$__error__', { error: err.message }), 'error')
    }
    setCreating(false)
  }

  return (
    <Modal
      visible={visible}
      title={t('新建知识库')}
      onClose={onClose}
      width={460}
      footer={
        <ModalFooterButtons
          cancelText={t('取消')}
          confirmText={creating ? t('创建中…') : t('创建')}
          onCancel={() => {
            if (!creating) onClose()
          }}
          onConfirm={handleCreate}
          confirmLoading={creating}
        />
      }>
      <div className="kb-create-modal-body">
        <div className="kb-create-field">
          <label className="kb-create-label">{t('名称')} *</label>
          <input
            className="kb-create-input"
            placeholder={t('例如：项目文档')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && !creating && name.trim() && handleCreate()
            }
            autoFocus
          />
        </div>
        <div className="kb-create-field">
          <label className="kb-create-label">{t('一句话说明（可选）')}</label>
          <textarea
            className="kb-create-textarea"
            placeholder={t('例如：这个项目的架构、规范和常见问题')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
          />
        </div>
      </div>
    </Modal>
  )
}
