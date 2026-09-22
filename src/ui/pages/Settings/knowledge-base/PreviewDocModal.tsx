/**
 * 文档预览弹窗
 *
 * 打开时按 (kbId, docId) 拉取文档全文并展示（只读）。
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal from '@/ui/components/shared/Modal'

interface Props {
  visible: boolean
  kbId: string
  docId: string
  docName: string
  onClose: () => void
}

export default function PreviewDocModal({
  visible,
  kbId,
  docId,
  docName,
  onClose,
}: Props) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setContent('')
    setLoading(true)
    ;(async () => {
      try {
        const text = await ragService.getDocumentContent(kbId, docId)
        if (!cancelled) setContent(text)
      } catch (err: any) {
        if (!cancelled) {
          setContent(tpl('加载文档内容失败: $__error__', { error: err.message }))
        }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // docName 仅用于标题展示，不参与加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, kbId, docId])

  return (
    <Modal
      visible={visible}
      title={docName || t('文档预览')}
      onClose={onClose}
      width={700}
      height={500}>
      <div className="kb-preview-body">
        {loading ? (
          <div className="kb-preview-loading">{t('加载中...')}</div>
        ) : (
          <pre className="kb-preview-content">{content}</pre>
        )}
      </div>
    </Modal>
  )
}
