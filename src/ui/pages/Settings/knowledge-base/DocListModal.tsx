/**
 * 文档列表弹窗：自持文档列表 / 搜索 / 分页 / 试搜的全部 state，并托管三个子弹窗
 *（预览 / 新建 / 编辑）；知识库维度的刷新通过 `onChanged` 回调父级。
 *
 * 文案口径：说「文档 / 内容 / 搜一下」，不说「片段 / chunk / 向量检索」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
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

  /** 刷新当前知识库的文档列表 */
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
        showToastMsg(tpl('搜索失败：$__error__', { error: err.message }), 'error')
      }
      setDocSearching(false)
      docSearchTimerRef.current = null
    }, 300)
  }, [docSearchQuery, kbId, docSearchMode])

  const handleRemoveDoc = async (docId: string, docName: string) => {
    const confirmed = await MessageBox.propt(
      t('删除文档'),
      tpl('删除「$__name__」后，AI 就查不到它的内容了。', { name: docName }),
      { danger: true, confirmText: t('删除') },
    )
    if (!confirmed) return
    try {
      await ragService.removeDocument(kbId, docId)
      showToastMsg(t('文档已删除'), 'success')
      await refreshDocList()
      await onChanged?.()
    } catch (err: any) {
      showToastMsg(tpl('删除失败：$__error__', { error: err.message }), 'error')
    }
  }

  const handleClearAllDocs = async () => {
    if (!kbId || docs.length === 0) return
    const confirmed = await MessageBox.propt(
      t('清空文档'),
      tpl('「$__name__」里的 $__count__ 份文档会被全部删除，无法恢复。', {
        name: kbName,
        count: docs.length,
      }),
      { danger: true, confirmText: t('全部删除') },
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
      tpl('已删除 $__success__ 份文档，$__fail__ 份没删掉', {
        success: successCount,
        fail: failCount,
      }),
      failCount > 0 ? 'error' : 'success',
    )
    await refreshDocList()
    await onChanged?.()
  }

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

  const handleSearch = async () => {
    // 检索目标就是当前这个知识库（弹窗是「从某个库进来的」，没有全局默认库这一层）
    if (!kbId) return
    if (!searchQuery.trim()) {
      showToastMsg(t('请输入要搜索的内容'), 'error')
      return
    }
    setSearching(true)
    setSearchResults(null)
    try {
      const result = await ragService.query(kbId, searchQuery.trim(), 5)
      if (result.results.length === 0) {
        setSearchResults(t('没找到相关内容，换个说法再试试'))
      } else {
        setSearchResults(result.context)
      }
    } catch (err: any) {
      setSearchResults(tpl('搜索失败：$__error__', { error: err.message }))
    }
    setSearching(false)
  }

  return (
    <>
      <Modal
        visible={visible}
        title={`${kbName} · ${t('文档')}`}
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
                        {tpl('共 $__count__ 份文档', { count: docs.length })}
                        {docSearchQuery.trim() &&
                          `，${tpl('筛选出 $__count__ 份', { count: totalFiltered })}`}
                      </span>
                    </div>
                  )
                })()}
            </div>
            <div className="kb-doclist-footer-right">
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleUpload}
                title={t('从电脑里选文档加进来，可一次选多个')}>
                {t('添加文档')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleUploadFolder}
                title={t('把整个文件夹加进来，里面的 Markdown / TXT 会自动读入')}>
                {t('添加文件夹')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleExportKb}
                disabled={docs.length === 0}
                title={t('导出成压缩包，方便备份或换到别的电脑')}>
                {t('导出')}
              </button>
              <button
                className="kb-btn kb-btn-sm kb-btn-danger"
                onClick={handleClearAllDocs}
                disabled={docs.length === 0}
                title={t('删除这个知识库里的全部文档（不可恢复）')}>
                {t('清空文档')}
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
                      placeholder={t('搜索文档…')}
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
                      }}
                      title={t('按文档名找')}>
                      {t('按名称')}
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
                      disabled={docSearching}
                      title={t('在文档正文里找（能找出正文包含这两个字的文档）')}>
                      {docSearching ? t('搜索中…') : t('按内容')}
                    </button>
                    <span className="kb-doc-search-sep" />
                    <button
                      className="kb-btn kb-btn-sm kb-btn-primary"
                      onClick={() => setShowNewDoc(true)}
                      title={t('直接写一段内容存进来，不用先建文件')}>
                      + {t('新建文档')}
                    </button>
                  </div>
                )}

                {/* 搜索栏在 scroll-view 外面，始终可见；这里只有列表滚动 */}
                <div className="kb-doclist-scroll">
                  {docs.length === 0 ? (
                    <div className="kb-empty">
                      <div className="kb-empty-title">{t('还没有文档')}</div>
                      <p className="kb-empty-desc">
                        {t(
                          '把 PDF、Markdown 或 TXT 加进来，AI 回答你的问题时就能查到这些内容。',
                        )}
                      </p>
                      <button
                        className="kb-btn kb-btn-primary"
                        onClick={handleUpload}>
                        {t('添加文档')}
                      </button>
                    </div>
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
                                <div className="kb-empty-title">
                                  {t('没有匹配的文档')}
                                </div>
                                <p className="kb-empty-desc">
                                  {t('换个关键词，或把上面的搜索框清空')}
                                </p>
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
                                        <span className="doc-item-meta">
                                          {tpl('$__count__ 段内容', {
                                            count: doc.chunk_count,
                                          })}
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
                                          title={t('看看这份文档里的内容')}>
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
                                          title={t('改名字，或直接改里面的内容')}>
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

                          </>
                        )
                      })()}
                    </>
                  )}
                </div>
              </div>

              {/* 右侧：在当前知识库里试搜一下（“能不能搜到”是用户最直接的验证方式） */}
              <div className="kb-doclist-right">
                <div className="kb-search-section">
                  <label className="kb-search-label">{t('在这里搜一下')}</label>
                  <p className="kb-search-hint">
                    {t('输入一句话，看看能从这些文档里找到什么。')}
                  </p>
                  <div className="kb-search-test">
                    <input
                      className="kb-search-input"
                      placeholder={t('例如：怎么启动开发环境')}
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
                      {searching ? t('搜索中…') : t('搜索')}
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

      <PreviewDocModal
        visible={!!previewTarget}
        kbId={kbId}
        docId={previewTarget?.docId || ''}
        docName={previewTarget?.docName || ''}
        onClose={() => setPreviewTarget(null)}
      />

      <NewDocModal
        visible={showNewDoc}
        kbId={kbId}
        onClose={() => setShowNewDoc(false)}
        onCreated={async () => {
          await refreshDocList()
          await onChanged?.()
        }}
      />

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
