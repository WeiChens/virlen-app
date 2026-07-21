/**
 * knowledge-base-settings — 知识库管理页面
 *
 * 功能：
 * - RAG 开关 / 默认知识库设置
 * - 知识库创建（弹窗）/ 删除 / 列表
 * - 文档上传 / 删除 / 编辑 / 预览
 * - 检索测试
 */

import { useEffect, useState, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Select from '@/ui/components/shared/Select'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import type { KnowledgeBase, KnowledgeBaseDocument } from '@/domain/ports'
import './knowledge-base-settings.scss'

/** 弹出 toast 消息（简单实现，避免引入 toast 组件的复杂依赖） */
function showToastMsg(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = document.createElement('div')
  el.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    padding: 10px 20px; border-radius: 8px; font-size: 14px;
    z-index: 9999; color: white; max-width: 80vw; text-align: center;
    background: ${type === 'success' ? '#2e7d32' : type === 'error' ? '#c62828' : '#1565c0'};
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: fadeIn 0.2s ease;
  `
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity 0.3s'
    setTimeout(() => el.remove(), 300)
  }, 3000)
}

function KnowledgeBaseSettings() {
  const s = settingsState.value
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedKbId, setExpandedKbId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<Record<string, KnowledgeBaseDocument[]>>({})
  const [docsLoading, setDocsLoading] = useState<Record<string, boolean>>({})

  // 创建知识库弹窗
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKbName, setNewKbName] = useState('')
  const [newKbDesc, setNewKbDesc] = useState('')
  const [creating, setCreating] = useState(false)

  // 文档预览弹窗
  const [previewDocName, setPreviewDocName] = useState('')
  const [previewDocContent, setPreviewDocContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showPreviewModal, setShowPreviewModal] = useState(false)

  // 检索测试
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  /** 默认知识库选项（供 Select 组件使用） */
  const kbSelectOptions = [
    { value: '', label: t('未选择') },
    ...kbs.map((kb) => ({ value: kb.id, label: kb.name })),
  ]

  /** 加载知识库列表 */
  const loadKbs = useCallback(async () => {
    setLoading(true)
    try {
      const list = await ragService.listKnowledgeBases()
      setKbs(list)
    } catch (err: any) {
      showToastMsg(`加载知识库失败: ${err.message}`, 'error')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadKbs()
  }, [loadKbs])

  /** 打开创建知识库弹窗 */
  const openCreateModal = () => {
    setNewKbName('')
    setNewKbDesc('')
    setShowCreateModal(true)
  }

  /** 创建知识库 */
  const handleCreate = async () => {
    if (!newKbName.trim()) {
      showToastMsg('请输入知识库名称', 'error')
      return
    }
    setCreating(true)
    try {
      await ragService.createKnowledgeBase(newKbName.trim(), newKbDesc.trim())
      showToastMsg('知识库创建成功', 'success')
      setShowCreateModal(false)
      setNewKbName('')
      setNewKbDesc('')
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`创建失败: ${err.message}`, 'error')
    }
    setCreating(false)
  }

  /** 删除知识库 */
  const handleDelete = async (kbId: string, name: string) => {
    const confirmed = await MessageBox.propt(
      t('删除知识库'),
      t(`确定要删除知识库「${name}」吗？此操作不可撤销。`),
    )
    if (!confirmed) return
    try {
      await ragService.deleteKnowledgeBase(kbId)
      showToastMsg('知识库已删除', 'success')
      if (expandedKbId === kbId) setExpandedKbId(null)
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`删除失败: ${err.message}`, 'error')
    }
  }

  /** 展开/收起知识库（加载文档列表） */
  const toggleExpand = async (kbId: string) => {
    if (expandedKbId === kbId) {
      setExpandedKbId(null)
      return
    }
    setExpandedKbId(kbId)
    if (!documents[kbId]) {
      setDocsLoading((prev) => ({ ...prev, [kbId]: true }))
      try {
        const docs = await ragService.listDocuments(kbId)
        setDocuments((prev) => ({ ...prev, [kbId]: docs }))
      } catch (err: any) {
        showToastMsg(`加载文档列表失败: ${err.message}`, 'error')
      }
      setDocsLoading((prev) => ({ ...prev, [kbId]: false }))
    }
  }

  /** 上传文档 */
  const handleUpload = async (kbId: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: '文档',
            extensions: ['pdf', 'md', 'markdown', 'txt'],
          },
        ],
      })
      if (!selected) return

      showToastMsg('正在处理文档，请稍候...', 'info')
      const doc = await ragService.addDocument(kbId, selected as string)
      showToastMsg(`文档「${doc.file_name}」添加成功`, 'success')

      // 刷新文档列表
      const docs = await ragService.listDocuments(kbId)
      setDocuments((prev) => ({ ...prev, [kbId]: docs }))
    } catch (err: any) {
      showToastMsg(`上传失败: ${err.message}`, 'error')
    }
  }

  /** 删除文档 */
  const handleRemoveDoc = async (kbId: string, docId: string, docName: string) => {
    const confirmed = await MessageBox.propt(
      t('删除文档'),
      t(`确定要删除文档「${docName}」吗？`),
    )
    if (!confirmed) return
    try {
      await ragService.removeDocument(kbId, docId)
      showToastMsg('文档已删除', 'success')
      const docs = await ragService.listDocuments(kbId)
      setDocuments((prev) => ({ ...prev, [kbId]: docs }))
      // 刷新知识库列表（更新 document_count / chunk_count）
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`删除失败: ${err.message}`, 'error')
    }
  }

  /** 编辑文档 — 用新文件替换 */
  const handleEditDoc = async (kbId: string, docId: string, docName: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: '文档',
            extensions: ['pdf', 'md', 'markdown', 'txt'],
          },
        ],
      })
      if (!selected) return

      showToastMsg(`正在更新文档「${docName}」...`, 'info')
      const doc = await ragService.editDocument(kbId, docId, selected as string)
      showToastMsg(`文档已更新为「${doc.file_name}」`, 'success')

      // 刷新文档列表和知识库列表
      const docs = await ragService.listDocuments(kbId)
      setDocuments((prev) => ({ ...prev, [kbId]: docs }))
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`编辑失败: ${err.message}`, 'error')
    }
  }

  /** 预览文档 */
  const handlePreviewDoc = async (kbId: string, docId: string, docName: string) => {
    setPreviewDocName(docName)
    setPreviewDocContent('')
    setShowPreviewModal(true)
    setPreviewLoading(true)
    try {
      const content = await ragService.getDocumentContent(kbId, docId)
      setPreviewDocContent(content)
    } catch (err: any) {
      setPreviewDocContent(`加载文档内容失败: ${err.message}`)
    }
    setPreviewLoading(false)
  }

  /** 检索测试 */
  const handleSearch = async () => {
    const kbId = expandedKbId || s.ragDefaultKnowledgeBaseId
    if (!kbId) {
      showToastMsg('请先选择一个知识库', 'error')
      return
    }
    if (!searchQuery.trim()) {
      showToastMsg('请输入搜索内容', 'error')
      return
    }
    setSearching(true)
    setSearchResults(null)
    try {
      const result = await ragService.query(kbId, searchQuery.trim(), 5)
      if (result.results.length === 0) {
        setSearchResults('未找到相关结果')
      } else {
        setSearchResults(result.context)
      }
    } catch (err: any) {
      setSearchResults(`检索失败: ${err.message}`)
    }
    setSearching(false)
  }

  return (
    <div className="knowledge-base-settings">
      {/* RAG 开关设置 */}
      <div className="kb-section">
        <h3>{t('RAG 知识库')}</h3>
        <div className="kb-toggle-row">
          <button
            className={`kb-toggle ${s.ragEnabled ? 'active' : ''}`}
            onClick={() => {
              settingsState.setValue('ragEnabled', !s.ragEnabled)
              ragService.setConfig({ enabled: !s.ragEnabled })
            }}
            title={s.ragEnabled ? t('关闭 RAG') : t('开启 RAG')}
          >
            <span className="kb-toggle-knob" />
          </button>
          <span>{s.ragEnabled ? t('已启用') : t('已禁用')}</span>
        </div>

        <div className="kb-default-kb-row">
          <label className="kb-label">{t('默认知识库')}</label>
          <Select
            value={s.ragDefaultKnowledgeBaseId}
            onChange={(v) => {
              settingsState.setValue('ragDefaultKnowledgeBaseId', v)
              ragService.setConfig({ defaultKnowledgeBaseId: v })
            }}
            options={kbSelectOptions}
            placeholder={t('未选择')}
            width={220}
          />
        </div>
      </div>

      {/* 知识库列表 */}
      <div className="kb-section">
        <div className="kb-header-row">
          <div className="kb-header-title">
            <h3>{t('知识库列表')}</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              ({kbs.length})
            </span>
          </div>
          <div className="kb-header-actions">
            <button
              className="kb-btn kb-btn-primary kb-btn-sm"
              onClick={openCreateModal}
            >
              {t('创建知识库')}
            </button>
            <button className="kb-btn kb-btn-sm" onClick={loadKbs} disabled={loading}>
              {t('刷新')}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="kb-loading">{t('加载中...')}</div>
        ) : kbs.length === 0 ? (
          <div className="kb-empty">{t('暂无知识库，请先创建')}</div>
        ) : (
          <div className="kb-list">
            {kbs.map((kb) => (
              <div key={kb.id}>
                <div className="kb-card">
                  <div
                    className="kb-card-info"
                    onClick={() => toggleExpand(kb.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="kb-card-name">{kb.name}</div>
                    {kb.description && (
                      <div className="kb-card-desc">{kb.description}</div>
                    )}
                    <div className="kb-card-meta">
                      {kb.document_count} {t('个文档')} · {kb.chunk_count} {t('个片段')}
                    </div>
                  </div>
                  <div className="kb-card-actions">
                      <button
                        className="kb-btn kb-btn-sm kb-btn-primary"
                        onClick={() => handleUpload(kb.id)}
                        title={t('上传文档到该知识库')}
                      >
                        {t('上传文档')}
                      </button>
                    <button
                      className="kb-btn kb-btn-sm kb-btn-danger"
                      onClick={() => handleDelete(kb.id, kb.name)}
                    >
                      {t('删除')}
                    </button>
                  </div>
                </div>

                {/* 展开的文档列表 */}
                {expandedKbId === kb.id && (
                  <div className="kb-expanded-content">

                    {docsLoading[kb.id] ? (
                      <div className="kb-loading">{t('加载文档列表...')}</div>
                    ) : !documents[kb.id] || documents[kb.id].length === 0 ? (
                      <div className="kb-empty" style={{ padding: '16px' }}>
                        {t('暂无文档')}
                      </div>
                    ) : (
                      <div className="doc-list">
                        {documents[kb.id]!.map((doc) => (
                          <div key={doc.id} className="doc-item">
                            <div className="doc-item-info">
                              <span className="doc-item-name">{doc.file_name}</span>
                              <span className={`doc-item-status status-${doc.status}`}>
                                {doc.status === 'ready'
                                  ? t('就绪')
                                  : doc.status === 'processing'
                                    ? t('处理中')
                                    : t('错误')}
                              </span>
                              <span className="doc-item-meta">
                                {doc.chunk_count} {t('个片段')}
                              </span>
                            </div>
                            <div className="doc-item-actions">
                              <button
                                className="kb-btn kb-btn-sm"
                                onClick={() => handlePreviewDoc(kb.id, doc.id, doc.file_name)}
                                title={t('预览文档内容')}
                              >
                                {t('预览')}
                              </button>
                              <button
                                className="kb-btn kb-btn-sm"
                                onClick={() => handleEditDoc(kb.id, doc.id, doc.file_name)}
                                title={t('用新文件替换此文档')}
                              >
                                {t('编辑')}
                              </button>
                              <button
                                className="kb-btn kb-btn-sm kb-btn-danger"
                                onClick={() => handleRemoveDoc(kb.id, doc.id, doc.file_name)}
                              >
                                {t('删除')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 检索测试 */}
                    <div className="kb-search-section">
                      <label className="kb-search-label">{t('检索测试')}</label>
                      <div className="kb-search-test">
                        <input
                          className="kb-search-input"
                          placeholder={t('输入搜索内容...')}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        />
                        <button
                          className="kb-btn kb-btn-primary kb-btn-sm"
                          onClick={handleSearch}
                          disabled={searching || !searchQuery.trim()}
                        >
                          {searching ? t('搜索中...') : t('搜索')}
                        </button>
                      </div>
                      {searchResults && (
                        <div className="kb-search-results">
                          {searchResults}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建知识库弹窗 */}
      <Modal
        visible={showCreateModal}
        title={t('创建知识库')}
        onClose={() => setShowCreateModal(false)}
        width={460}
      >
        <div className="kb-create-modal-body">
          <div className="kb-create-field">
            <label className="kb-create-label">{t('知识库名称')} *</label>
            <input
              className="kb-create-input"
              placeholder={t('请输入知识库名称')}
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !creating && newKbName.trim() && handleCreate()}
              autoFocus
            />
          </div>
          <div className="kb-create-field">
            <label className="kb-create-label">{t('描述（可选）')}</label>
            <textarea
              className="kb-create-textarea"
              placeholder={t('请输入知识库描述')}
              value={newKbDesc}
              onChange={(e) => setNewKbDesc(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <ModalFooterButtons
          cancelText={t('取消')}
          confirmText={creating ? t('创建中...') : t('创建')}
          onCancel={() => {
            if (!creating) setShowCreateModal(false)
          }}
          onConfirm={handleCreate}
          confirmLoading={creating}
        />
      </Modal>

      {/* 文档预览弹窗 */}
      <Modal
        visible={showPreviewModal}
        title={previewDocName || t('文档预览')}
        onClose={() => setShowPreviewModal(false)}
        width={700}
        height={500}
      >
        <div className="kb-preview-body">
          {previewLoading ? (
            <div className="kb-preview-loading">{t('加载中...')}</div>
          ) : (
            <pre className="kb-preview-content">{previewDocContent}</pre>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default observer(KnowledgeBaseSettings)
