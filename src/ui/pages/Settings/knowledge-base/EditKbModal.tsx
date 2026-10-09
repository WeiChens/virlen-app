/**
 * 改知识库的名字 / 说明
 *
 * 为什么要有它：卡片上原本只有「进」与「删」—— 名字写错只能删了重建（里面的文档一起没）。
 *
 * 只对**手动建的库**开放：默认知识库与记忆详情都以名字当「缓存失效后认领」的锚点
 *（`init_default_knowledge_base` / `memory::kb::ensure_memory_kb`），改名会让锚点失效、
 * 旧的详情文档变孤儿 —— 所以 builtin 的卡片上根本不画这个入口，后端也会拒（双保险）。
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { showToast } from '@/ui/components/shared/Toast'

interface Props {
  visible: boolean
  kbId: string
  /** 现有名字 / 说明（打开时填进表单） */
  kbName: string
  kbDescription: string
  onClose: () => void
  onSaved?: () => void | Promise<void>
}

export default function EditKbModal({
  visible,
  kbId,
  kbName,
  kbDescription,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [saving, setSaving] = useState(false)

  // 打开时用当前值填表（而不是留着上一次编辑的残值）
  useEffect(() => {
    if (visible) {
      setName(kbName)
      setDesc(kbDescription)
    }
  }, [visible, kbName, kbDescription])

  const handleSave = async () => {
    if (!name.trim()) {
      showToast(t('名字不能为空'), 3000)
      return
    }
    setSaving(true)
    try {
      await ragService.updateKnowledgeBase(kbId, name.trim(), desc.trim())
      showToast(tpl('已改成「$__name__」', { name: name.trim() }))
      onClose()
      await onSaved?.()
    } catch (err: any) {
      showToast(tpl('保存失败：$__error__', { error: err.message }), 3000)
    }
    setSaving(false)
  }

  return (
    <Modal
      visible={visible}
      title={t('改知识库名称')}
      onClose={() => {
        if (!saving) onClose()
      }}
      width={460}
      footer={
        <ModalFooterButtons
          cancelText={t('取消')}
          confirmText={saving ? t('保存中…') : t('保存')}
          onCancel={() => {
            if (!saving) onClose()
          }}
          onConfirm={handleSave}
          confirmLoading={saving}
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
              e.key === 'Enter' && !saving && name.trim() && handleSave()
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
