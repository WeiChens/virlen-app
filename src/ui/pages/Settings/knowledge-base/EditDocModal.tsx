/**
 * 文档编辑弹窗（改名称 + 改内容，支持重新上传文件覆盖内容）
 *
 * ⚠️ 两条替换路径分开走（见 `handleReupload`）：文本文件读进输入框让用户先看一眼，
 * PDF 是二进制、不能当文本读，改用 `editDocument` 让后端重新解析并直接替换。
 */
import { useEffect, useState } from 'react'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import {
  exceedsSize,
  isPdfFile,
  MAX_PARSE_DOC_BYTES,
  MAX_TEXT_FILE_BYTES,
  mbOf,
  tryDecodeTextFile,
} from './file-import'

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
          showToast(
            tpl('加载文档内容失败: $__error__', { error: err.message }),
            3000,
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
      showToast(t('文档名字不能为空'), 3000)
      return
    }
    setSaving(true)
    try {
      await ragService.editTextDocument(kbId, docId, name.trim(), content)
      showToast(tpl('已保存「$__name__」', { name: name.trim() }))
      onClose()
      await onSaved?.()
    } catch (err: any) {
      showToast(tpl('保存失败：$__error__', { error: err.message }), 3000)
    }
    setSaving(false)
  }

  /**
   * 用电脑上的一个文件替换正文。
   *
   * 不按扩展名筛（与「添加文档」同一口径）：能读成文本的当文本，PDF 交给后端解析。
   * 所以要分两条路，分的时候只看「是不是 PDF」，不看扩展名白名单：
   * - 文本：读进输入框，用户确认后再点保存；
   * - PDF：不读进输入框，走 `editDocument` 让后端解析 → 重新分块 → 直接替换。
   *   跳过了「先看一眼」这一步，所以先要一次确认。
   *
   * 两条路的大小上限与「添加文档」一致：文本 2 MB（[`MAX_TEXT_FILE_BYTES`]）、
   * PDF 50 MB（[`MAX_PARSE_DOC_BYTES`]）—— 把整篇正文换成一份超长文本，分块与嵌入都吃不消。
   */
  const handleReupload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [{ name: t('所有文件'), extensions: ['*'] }],
      })
      if (!selected) return

      const filePath = selected as string
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath

      if (isPdfFile(filePath)) {
        if (await exceedsSize(filePath, MAX_PARSE_DOC_BYTES)) {
          showToast(
            tpl('这个文件超过 $__limit__ MB，没有读进来', {
              limit: mbOf(MAX_PARSE_DOC_BYTES),
            }),
            3000,
          )
          return
        }
        const confirmed = await MessageBox.propt(
          t('用这个 PDF 替换文档内容？'),
          tpl(
            '「$__name__」的正文会被这个 PDF 里抽出的文字整份替换，改完无法撤回。',
            { name: fileName },
          ),
          { danger: true, confirmText: t('替换') },
        )
        if (!confirmed) return
        setSaving(true)
        try {
          await ragService.editDocument(kbId, docId, filePath)
          showToast(tpl('已用「$__name__」替换正文', { name: fileName }))
          onClose()
          await onSaved?.()
        } catch (err: any) {
          showToast(tpl('替换失败：$__error__', { error: err.message }), 3000)
        }
        setSaving(false)
        return
      }

      showToast(tpl('正在读取文件「$__name__」…', { name: fileName }))

      if (await exceedsSize(filePath, MAX_TEXT_FILE_BYTES)) {
        showToast(
          tpl('这个文件超过 $__limit__ MB，没有读进来', {
            limit: mbOf(MAX_TEXT_FILE_BYTES),
          }),
          3000,
        )
        return
      }

      // 使用编码检测读取文件内容
      const decoded = await tryDecodeTextFile(filePath)
      if (decoded) {
        setName(fileName)
        setContent(decoded.text)
        showToast(
          tpl('已加载「$__name__」（$__encoding__），点击保存以确认修改', {
            name: fileName,
            encoding: decoded.encoding,
          }),
        )
      } else {
        // 所有编码都失败（或内容看着就不是文本）
        setName(fileName)
        showToast(t('这个文件读不出文字（可能是二进制文件），内容请手动粘贴'))
      }
    } catch (err: any) {
      showToast(tpl('文件读取失败: $__error__', { error: err.message }), 3000)
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
            disabled={saving}
            title={t(
              '选一个文件替换正文：文本文件会读进输入框等你看一眼再保存，PDF 会直接整份替换',
            )}>
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
