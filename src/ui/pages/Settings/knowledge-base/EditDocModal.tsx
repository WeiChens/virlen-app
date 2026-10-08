/**
 * 文档编辑弹窗（改名称 + 改内容，支持重新上传文件覆盖内容）
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { showToastMsg } from './toast'
import { tryDecodeTextFile } from './file-import'

interface Props {
  visible: boolean
  kbId: string
  docId: string
  docName: string
  onClose: () => void
  onSaved?: () => void | Promise<void>
}

export default function EditDocModal({
  visible,
  kbId,
  docId,
  docName,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // 打开时按 (kbId, docId) 拉取内容填充编辑框
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setName(docName)
    setContent('')
    setLoading(true)
    ;(async () => {
      try {
        const text = await ragService.getDocumentContent(kbId, docId)
        if (!cancelled) setContent(text)
      } catch (err: any) {
        if (!cancelled) {
          showToastMsg(
            tpl('加载文档内容失败: $__error__', { error: err.message }),
            'error',
          )
          setContent('')
        }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [visible, kbId, docId, docName])

  /** 保存文档编辑（名称 + 内容文本） */
  const handleSave = async () => {
    if (!name.trim()) {
      showToastMsg(t('文档名字不能为空'), 'error')
      return
    }
    setSaving(true)
    try {
      await ragService.editTextDocument(kbId, docId, name.trim(), content)
      showToastMsg(tpl('已保存「$__name__」', { name: name.trim() }), 'success')
      onClose()
      await onSaved?.()
    } catch (err: any) {
      showToastMsg(tpl('保存失败：$__error__', { error: err.message }), 'error')
    }
    setSaving(false)
  }

  /** 用电脑上的一个文件代替内容 — 只填进输入框，还要点保存才生效 */
  const handleReupload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: t('文档'),
            extensions: ['pdf', 'md', 'markdown', 'txt'],
          },
        ],
      })
      if (!selected) return

      const filePath = selected as string
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath

      showToastMsg(tpl('正在读取文件「$__name__」...', { name: fileName }), 'info')

      // 使用编码检测读取文件内容
      const decoded = await tryDecodeTextFile(filePath)
      if (decoded) {
        setName(fileName)
        setContent(decoded.text)
        showToastMsg(
          tpl('已加载「$__name__」（$__encoding__），点击保存以确认修改', {
            name: fileName,
            encoding: decoded.encoding,
          }),
          'success',
        )
      } else {
        // 所有编码都失败
        setName(fileName)
        showToastMsg(
          t('这个文件的编码读不出来，名字已经改了，内容请手动粘贴'),
          'info',
        )
      }
    } catch (err: any) {
      showToastMsg(tpl('文件读取失败: $__error__', { error: err.message }), 'error')
    }
  }

  return (
    <Modal
      visible={visible}
      title={t('编辑文档')}
      onClose={() => {
        if (!saving) onClose()
      }}
      width={700}
      height={500}
      footer={
        <div className="kb-edit-footer">
          <button
            className="kb-btn kb-btn-sm"
            onClick={handleReupload}
            title={t('选一个文件，把里面的文字读进下面的输入框（还没保存）')}>
            {t('用文件替换内容')}
          </button>
          <ModalFooterButtons
            cancelText={t('取消')}
            confirmText={saving ? t('保存中...') : t('保存')}
            onCancel={() => {
              if (!saving) onClose()
            }}
            onConfirm={handleSave}
            confirmLoading={saving}
          />
        </div>
      }>
      <div className="kb-edit-modal-body">
        {loading ? (
          <div className="kb-edit-loading">{t('加载文档内容...')}</div>
        ) : (
          <>
            <div className="kb-edit-field">
              <label className="kb-edit-label">{t('文档名字')}</label>
              <input
                className="kb-edit-input"
                placeholder={t('给这份文档起个名字')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="kb-edit-field">
              <label className="kb-edit-label">{t('内容')}</label>
              <textarea
                className="kb-edit-textarea"
                placeholder={t('把内容粘贴或写在这里')}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
