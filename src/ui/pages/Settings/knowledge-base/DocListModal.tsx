/**
 * 文档列表弹窗
 *
 * 自持文档列表 / 搜索 / 分页 / 检索测试的全部 state，并托管三个子弹窗
 * （预览 / 新建 / 编辑）。知识库维度的刷新通过 onChanged 回调父级。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal from '@/ui/components/shared/Modal'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import type { KnowledgeBaseDocument } from '@/domain/ports'
import { showToastMsg } from './toast'
import { exportKnowledgeBaseZip } from './export'
import { pickUploadFiles, pickUploadFolder } from './file-import'
import PreviewDocModal from './PreviewDocModal'
import NewDocModal from './NewDocModal'
import EditDocModal from './EditDocModal'

const PAGE_SIZE = 10

interface Props {
  visible: boolean
  kbId: string
  kbName: string
  onClose: () => void
  /** 文档增删改后通知父级刷新知识库列表（文档数 / 片段数变化） */
  onChanged?: () => void | Promise<void>
}

function DocListModal({
  visible,
  kbId,
  kbName,
  onClose,
  onChanged,
}: Props) {
  const s = settingsState.value

  const [docs, setDocs] = useState<KnowledgeBaseDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  // 检索测试
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  // 文档列表搜索
  const [docSearchQuery, setDocSearchQuery] = useState('')
  const [docSearchMode, setDocSearchMode] = useState<'title' | 'content'>('title')
  const [docSearching, setDocSearching] = useState(false)
  const [docSearchResultIds, setDocSearchResultIds] = useState<Set<string> | null>(
    null,
  )

  const docSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 子弹窗目标
  const [previewTarget, setPreviewTarget] = useState<{
    docId: string
    docName: string
  } | null>(null)
  const [editTarget, setEditTarget] = useState<{
    docId: string
    docName: string
  } | null>(null)
  const [showNewDoc, setShowNewDoc] = useState(false)

  /** 刷新文档列表（当前打开的知识库） */
  const refreshDocList = useCallback(async () => {
    if (!kbId) return
    setLoading(true)
    try {
      const list = await ragService.listDocuments(kbId)
      setDocs(list)
    } catch {
      // 静默失败
    }
    setLoading(false)
  }, [kbId])

  // 打开（或切换知识库）时重置全部内部状态并加载文档
  useEffect(() => {
    if (!visible) return
    setPage(1)
    setDocs([])
    setDocSearchQuery('')
    setDocSearchMode('title')
    setDocSearchResultIds(null)
    setSearchQuery('')
    setSearchResults(null)
    setPreviewTarget(null)
    setEditTarget(null)
    setShowNewDoc(false)
    void refreshDocList()
  }, [visible, kbId, refreshDocList])

  // 卸载时清理防抖定时器
  useEffect(() => {
    return () => {
      if (docSearchTimerRef.current) {
        clearTimeout(docSearchTimerRef.current)
      }
    }
  }, [])

  /** 文档列表搜索（带 300ms 防抖） */
  const handleDocSearch = useCallback(async () => {
    if (!docSearchQuery.trim() || !kbId) return

    if (docSearchMode === 'title') {
      // 标题搜索：前端过滤，不需要防抖
      setPage(1)
      return
    }

    // 内容搜索：防抖，避免快速打字时频繁请求
    if (docSearchTimerRef.current) {
      clearTimeout(docSearchTimerRef.current)
    }
    docSearchTimerRef.current = setTimeout(async () => {
      setDocSearching(true)
      setDocSearchResultIds(null)
      try {
        const result = await ragService.searchDocumentsContent(
          kbId,
          docSearchQuery.trim(),
        )
        const matchedIds = new Set(result)
        setDocSearchResultIds(matchedIds)
        setPage(1)
      } catch (err: any) {
        showToastMsg(tpl('搜索失败: $__error__', { error: err.message }), 'error')
      }
      setDocSearching(false)
      docSearchTimerRef.current = null
    }, 300)
  }, [docSearchQuery, kbId, docSearchMode])

  /** 删除文档 */
  const handleRemoveDoc = async (docId: string, docName: string) => {
    const confirmed = await MessageBox.propt(
      t('删除文档'),
      tpl('确定要删除文档「$__name__」吗？', { name: docName }),
      { danger: true },
    )
    if (!confirmed) return
    try {
      await ragService.removeDocument(kbId, docId)
      showToastMsg(t('文档已删除'), 'success')
      await refreshDocList()
      await onChanged?.()
    } catch (err: any) {
      showToastMsg(tpl('删除失败: $__error__', { error: err.message }), 'error')
    }
  }

  /** 清空知识库所有文档 */
  const handleClearAllDocs = async () => {
    if (!kbId || docs.length === 0) return
    const confirmed = await MessageBox.propt(
      t('清空所有文档'),
      t(
        tpl('确定要清空「$__name__」中的所有文档吗？（共 $__count__ 个）此操作不可撤销。', {
          name: kbName,
          count: docs.length,
        }),
      ),
      { danger: true },
    )
    if (!confirmed) return

    let successCount = 0
    let failCount = 0
    for (const doc of docs) {
      try {
        await ragService.removeDocument(kbId, doc.id)
        successCount++
      } catch {
        failCount++
      }
    }
    showToastMsg(
      tpl('清空完成：$__success__ 成功，$__fail__ 失败', {
        success: successCount,
        fail: failCount,
      }),
      failCount > 0 ? 'error' : 'success',
    )
    await refreshDocList()
    await onChanged?.()
  }

  /** 导出知识库为 ZIP */
  const handleExportKb = async () => {
    if (!kbId || docs.length === 0) return
    await exportKnowledgeBaseZip(kbId, kbName)
  }

  /** 上传后刷新：本弹窗文档列表 + 父级知识库列表 */
  const afterImport = useCallback(async () => {
    await refreshDocList()
    await onChanged?.()
  }, [refreshDocList, onChanged])

  const handleUpload = () => pickUploadFiles(kbId, afterImport)
  const handleUploadFolder = () => pickUploadFolder(kbId, afterImport)

  /** 检索测试 */
  const handleSearch = async () => {
    const targetKbId = kbId || s.ragDefaultKnowledgeBaseId
    if (!targetKbId) {
      showToastMsg(t('请先选择一个知识库'), 'error')
      return
    }
    if (!searchQuery.trim()) {
      showToastMsg(t('请输入搜索内容'), 'error')
      return
    }
    setSearching(true)
    setSearchResults(null)
    try {
      const result = await ragService.query(targetKbId, searchQuery.trim(), 5)
      if (result.results.length === 0) {
        setSearchResults(t('未找到相关结果'))
      } else {
        setSearchResults(result.context)
      }
    } catch (err: any) {
      setSearchResults(tpl('检索失败: $__error__', { error: err.message }))
    }
    setSearching(false)
  }

  return (
    <>
      <Modal
        visible={visible}
        title={`${kbName} - ${t('文档列表')}`}
        onClose={onClose}
        width={880}
        height={580}
        footer={
          <div className="kb-doclist-footer">
            <div className="kb-doclist-footer-left">
              {docs.length > 0 &&
                (() => {
                  // 计算过滤后的文档数用于分页
                  let totalFiltered = docs.length
                  if (docSearchQuery.trim() && docSearchMode === 'title') {
                    const q = docSearchQuery.trim().toLowerCase()
                    totalFiltered = docs.filter((d) =>
                      d.file_name.toLowerCase().includes(q),
                    ).length
                  } else if (docSearchResultIds) {
                    totalFiltered = docs.filter((d) =>
                      docSearchResultIds.has(d.id),
                    ).length
                  }
                  const totalPages = Math.ceil(totalFiltered / PAGE_SIZE)
                  const safePage = Math.min(page, Math.max(1, totalPages))
                  return (
                    <div className="kb-doclist-pagination">
                      {totalPages > 1 && (
                        <div className="kb-pagination-inline">
                          <button
                            className="kb-btn kb-btn-sm"
                            disabled={safePage <= 1}
                            onClick={() => setPage((p) => Math.max(1, p - 1))}>
                            {t('上一页')}
                          </button>
                          <span className="kb-pagination-info">
                            {safePage} / {totalPages}
                          </span>
                          <button
                            className="kb-btn kb-btn-sm"
                            disabled={safePage >= totalPages}
                            onClick={() =>
                              setPage((p) => Math.min(totalPages, p + 1))
                            }>
                            {t('下一页')}
                          </button>
                        </div>
                      )}
                      <span className="kb-pagination-total">
                        {t('共')} {docs.length} {t('个文档')}
                        {docSearchQuery.trim() &&
                          `，${t('筛选')} ${totalFiltered} ${t('个')}`}
                      </span>
                    </div>
                  )
                })()}
            </div>
            <div className="kb-doclist-footer-right">
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleUpload}
                title={t('上传文档到该知识库（支持多选）')}>
                {t('上传文档')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleUploadFolder}
                title={t('上传文件夹，自动导入所有文本文件')}>
                {t('上传文件夹')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleExportKb}
                disabled={docs.length === 0}
                title={t('导出知识库所有文档为 ZIP')}>
                {t('导出')}
              </button>
              <button
                className="kb-btn kb-btn-sm kb-btn-danger"
                onClick={handleClearAllDocs}
                disabled={docs.length === 0}
                title={t('清空该知识库中的所有文档')}>
                {t('清空所有文档')}
              </button>
            </div>
          </div>
        }>
        <div className="kb-doclist-modal-body">
          {loading ? (
            <div className="kb-loading">{t('加载中...')}</div>
          ) : (
            <div className="kb-doclist-layout">
              {/* 左侧：文档列表（2/3） */}
              <div className="kb-doclist-left">
                {/* 文档搜索栏 — 放在 scroll-view 外面，始终可见 */}
                {docs.length > 0 && (
                  <div className="kb-doc-search-bar">
                    <input
                      className="kb-search-input"
                      placeholder={t('搜索文档...')}
                      value={docSearchQuery}
                      onChange={(e) => setDocSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleDocSearch()}
                    />
                    <button
                      className={`kb-btn kb-btn-sm ${docSearchMode === 'title' ? 'kb-btn-primary' : ''}`}
                      onClick={() => {
                        setDocSearchMode('title')
                        setDocSearchResultIds(null)
                        setPage(1)
                      }}>
                      {t('搜索标题')}
                    </button>
                    <button
                      className={`kb-btn kb-btn-sm ${docSearchMode === 'content' ? 'kb-btn-primary' : ''}`}
                      onClick={() => {
                        setDocSearchMode('content')
                        if (docSearchQuery.trim()) {
                          handleDocSearch()
                        } else {
                          setDocSearchResultIds(null)
                        }
                      }}
                      disabled={docSearching}>
                      {docSearching ? t('搜索中...') : t('搜索内容')}
                    </button>
                    <span className="kb-doc-search-sep" />
                    <button
                      className="kb-btn kb-btn-sm kb-btn-primary"
                      onClick={() => setShowNewDoc(true)}
                      title={t('手动输入名称和内容创建新文档')}>
                      + {t('新建文档')}
                    </button>
                  </div>
                )}

                {/* scroll-view: 只有文档列表滚动，搜索栏保持固定 */}
                <div className="kb-doclist-scroll">
                  {docs.length === 0 ? (
                    <div className="kb-empty">{t('暂无文档')}</div>
                  ) : (
                    <>
                      {(() => {
                        // 计算过滤后的文档列表
                        let filtered = docs
                        if (docSearchQuery.trim() && docSearchMode === 'title') {
                          const q = docSearchQuery.trim().toLowerCase()
                          filtered = docs.filter((d) =>
                            d.file_name.toLowerCase().includes(q),
                          )
                        } else if (docSearchResultIds) {
                          filtered = docs.filter((d) =>
                            docSearchResultIds.has(d.id),
                          )
                        }

                        const totalFiltered = filtered.length
                        const totalPages = Math.ceil(totalFiltered / PAGE_SIZE)
                        const safePage = Math.min(
                          page,
                          Math.max(1, totalPages),
                        )
                        const startIdx = (safePage - 1) * PAGE_SIZE
                        const pageDocs = filtered.slice(
                          startIdx,
                          startIdx + PAGE_SIZE,
                        )

                        return (
                          <>
                            {pageDocs.length === 0 ? (
                              <div className="kb-empty">
                                {t('未找到匹配的文档')}
                              </div>
                            ) : (
                              <div className="doc-list">
                                {pageDocs.map((doc) => (
                                  <div key={doc.id} className="doc-item">
                                    <div className="doc-item-name">
                                      {doc.file_name}
                                    </div>
                                    <div className="doc-item-bottom-row">
                                      <div className="doc-item-left">
                                        {/* <span
                                          className={`doc-item-status status-${doc.status}`}>
                                          {doc.status === 'ready'
                                            ? t('就绪')
                                            : doc.status === 'processing'
                                              ? t('处理中')
                                              : t('错误')}
                                        </span> */}
                                        <span className="doc-item-meta">
                                          {doc.chunk_count} {t('个片段')}
                                        </span>
                                      </div>
                                      <div className="doc-item-actions">
                                        <button
                                          className="kb-btn kb-btn-sm"
                                          onClick={() =>
                                            setPreviewTarget({
                                              docId: doc.id,
                                              docName: doc.file_name,
                                            })
                                          }
                                          title={t('预览文档内容')}>
                                          {t('预览')}
                                        </button>
                                        <button
                                          className="kb-btn kb-btn-sm"
                                          onClick={() =>
                                            setEditTarget({
                                              docId: doc.id,
                                              docName: doc.file_name,
                                            })
                                          }
                                          title={t('编辑文档名称和内容')}>
                                          {t('编辑')}
                                        </button>
                                        <button
                                          className="kb-btn kb-btn-sm kb-btn-danger"
                                          onClick={() =>
                                            handleRemoveDoc(
                                              doc.id,
                                              doc.file_name,
                                            )
                                          }>
                                          {t('删除')}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* 重复的搜索结果提示已在上方，这里删除 */}
                          </>
                        )
                      })()}
                    </>
                  )}
                </div>
              </div>

              {/* 右侧：检索测试（1/3） */}
              <div className="kb-doclist-right">
                <div className="kb-search-section">
                  <label className="kb-search-label">{t('检索测试')}</label>
                  <div className="kb-search-test">
                    <input
                      className="kb-search-input"
                      placeholder={t('输入搜索内容...')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && !searching && handleSearch()
                      }
                    />
                    <button
                      className="kb-btn kb-btn-primary kb-btn-sm"
                      onClick={handleSearch}
                      disabled={searching || !searchQuery.trim()}>
                      {searching ? t('搜索中...') : t('搜索')}
                    </button>
                  </div>
                  {searchResults && (
                    <div className="kb-search-results">{searchResults}</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* 文档预览弹窗 */}
      <PreviewDocModal
        visible={!!previewTarget}
        kbId={kbId}
        docId={previewTarget?.docId || ''}
        docName={previewTarget?.docName || ''}
        onClose={() => setPreviewTarget(null)}
      />

      {/* 新建文档弹窗 */}
      <NewDocModal
        visible={showNewDoc}
        kbId={kbId}
        onClose={() => setShowNewDoc(false)}
        onCreated={async () => {
          await refreshDocList()
          await onChanged?.()
        }}
      />

      {/* 文档编辑弹窗 */}
      <EditDocModal
        visible={!!editTarget}
        kbId={kbId}
        docId={editTarget?.docId || ''}
        docName={editTarget?.docName || ''}
        onClose={() => setEditTarget(null)}
        onSaved={async () => {
          await refreshDocList()
          await onChanged?.()
        }}
      />
    </>
  )
}

export default observer(DocListModal)
