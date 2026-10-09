/**
 * 文档列表弹窗：自持文档列表 / 搜索 / 分页 / 试搜的全部 state，并托管三个子弹窗
 *（预览 / 新建 / 编辑）；知识库维度的刷新通过 `onChanged` 回调父级。
 *
 * 三个容易写错的点，都在下面注释里写明原因：
 * - 过滤与分页**只算一次**（`filterDocuments` + 组件级派生值）：以前 footer 和列表各算一遍，
 *   改一处漏一处；
 * - 搜索与刷新都带**序号护栏**：请求是异步的，旧结果落到新状态上会显示错的库/错的筛选结果；
 * - 记忆详情正文（`memory_detail_of`）不给删改：后端会拒，这里把按钮换成说明，不让用户白点。
 *
 * 导入（文件夹 / 压缩包）与「清空文档」都不在这里展开：前者跑在 `shared/TaskProgress`
 * 那个全局进度弹窗下（逐份报进度、随时可取消，见知识库的 `file-import.ts` / `export.ts`），
 * 后者同样走进度弹窗（见 `doc-delete.ts`）—— 本弹窗只负责刷新列表；
 * 单份删除则在行内按钮上显示「删除中…」并禁用（删一份要清向量库里的片段，不是瞬间返回）。
 *
 * 文案口径：说「文档 / 内容 / 搜一下」，不说「片段 / chunk / 向量检索」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Modal from '@/ui/components/shared/Modal'
import type { KnowledgeBaseDocument } from '@/domain/ports'
import { showToast } from '@/ui/components/shared/Toast'
import { clearAllDocuments, confirmRemoveDocument, removeDocumentNow } from './doc-delete'
import {
  exportKnowledgeBaseZip,
  importKnowledgeBaseZip,
} from './export'
import { pickUploadFiles, pickUploadFolder } from './file-import'
import { filterDocuments, pageSlice, totalPagesOf } from './doc-filter'
import type { DocSearchMode } from './doc-filter'
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
  const [docSearchMode, setDocSearchMode] = useState<DocSearchMode>('title')
  const [docSearching, setDocSearching] = useState(false)
  const [docSearchResultIds, setDocSearchResultIds] = useState<Set<string> | null>(
    null,
  )

  // 请求序号护栏（异步请求回来时可能已经「换库 / 换了搜索词」了）
  const docListSeqRef = useRef(0)
  const contentSearchSeqRef = useRef(0)

  // 单份删除：正在删的那一份（行内按钮显示「删除中…」并禁用，删除期间不允许再点下一份）
  const [deletingId, setDeletingId] = useState<string | null>(null)

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

  /**
   * 刷新当前知识库的文档列表。
   *
   * ⚠️ 序号护栏：刷新是异步的，而弹窗关闭、换库、连续增删都会再发一次请求 ——
   * 没有护栏时先发的那次后到，就会把另一个库（或者已被删掉的那份）的列表写进去。
   * 同目录的 `PreviewDocModal` / `EditDocModal` 用的是 `cancelled` 标志，同一回事。
   */
  const refreshDocList = useCallback(async () => {
    if (!kbId) return
    const seq = ++docListSeqRef.current
    setLoading(true)
    try {
      const list = await ragService.listDocuments(kbId)
      if (seq !== docListSeqRef.current) return
      setDocs(list)
    } catch {
      // 静默失败
    }
    if (seq === docListSeqRef.current) setLoading(false)
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

  // 卸载时把序号推到失效：在飞行的请求回来也不会再 setState
  useEffect(() => {
    return () => {
      docListSeqRef.current++
      contentSearchSeqRef.current++
    }
  }, [])

  /**
   * 「按内容」检索（关键词**作为参数**传入，不读 state）。
   *
   * ⚠️ 为什么不能在里面读 `docSearchMode`：切模式的按钮里刚 `setDocSearchMode('content')`，
   * 同一 tick 内 state 还是旧值 —— 靠 state 判断会直接 return，点了「按内容」什么也不发生。
   * 要不要搜由**调用方**（按钮 / 回车）决定。
   */
  const runContentSearch = useCallback(
    async (keywordRaw: string) => {
      const keyword = keywordRaw.trim()
      if (!keyword || !kbId) return

      const seq = ++contentSearchSeqRef.current
      setDocSearching(true)
      try {
        const result = await ragService.searchDocumentsContent(kbId, keyword)
        if (seq !== contentSearchSeqRef.current) return // 已经有更新的搜索了
        setDocSearchResultIds(new Set(result))
      } catch (err: any) {
        if (seq === contentSearchSeqRef.current) {
          showToast(tpl('搜索失败：$__error__', { error: err.message }), 3000)
        }
      }
      if (seq === contentSearchSeqRef.current) setDocSearching(false)
    },
    [kbId],
  )

  /**
   * 回车 = 搜索。
   *
   * 「按名称」是前端即时过滤（用不着回车，也不用请求后端），所以这里只处理「按内容」。
   * 以前这里给一个回车触发的一次性请求加了 300ms 防抖 —— 没有连续输入，只是白等 300ms。
   */
  const handleDocSearch = useCallback(() => {
    if (docSearchMode !== 'content') return
    void runContentSearch(docSearchQuery)
  }, [docSearchMode, docSearchQuery, runContentSearch])

  const handleRemoveDoc = async (docId: string, docName: string) => {
    if (deletingId) return
    // 先确认，再切「删除中…」：确认框还弹着就显示「删除中…」是骗人的（用户可能点取消）
    if (!(await confirmRemoveDocument(docName))) return
    setDeletingId(docId)
    try {
      if (await removeDocumentNow(kbId, docId)) {
        await refreshDocList()
        await onChanged?.()
      }
    } finally {
      setDeletingId(null)
    }
  }

  /** 清空文档：逐份删、全程有进度弹窗（可取消），结束时汇总写在弹窗上 */
  const handleClearAllDocs = async () => {
    if (deletingId) return
    const cleared = await clearAllDocuments(kbId, kbName, docs)
    if (cleared) {
      await refreshDocList()
      await onChanged?.()
    }
  }

  const handleExportKb = async () => {
    if (!kbId || docs.length === 0) return
    await exportKnowledgeBaseZip(kbId, kbName)
  }

  /** 导入压缩包（导出的逆操作）；有文档真的进了库才刷新 */
  const handleImportZip = async () => {
    if (!kbId) return
    const changed = await importKnowledgeBaseZip(
      kbId,
      kbName,
      // 同名判定要文档 id（覆盖走 editTextDocument，保留原文档名）
      new Map(docs.map((d) => [d.file_name, d.id])),
    )
    if (changed) {
      await refreshDocList()
      await onChanged?.()
    }
  }

  /** 上传后刷新：本弹窗文档列表 + 父级知识库列表 */
  const afterImport = useCallback(async () => {
    await refreshDocList()
    await onChanged?.()
  }, [refreshDocList, onChanged])

  const handleUpload = () => pickUploadFiles(kbId, afterImport)
  // 文件夹导入带进度弹窗（可取消），所以要把库名传下去
  const handleUploadFolder = () => pickUploadFolder(kbId, kbName, afterImport)

  const handleSearch = async () => {
    // 检索目标就是当前这个知识库（弹窗是「从某个库进来的」，没有全局默认库这一层）
    if (!kbId) return
    if (!searchQuery.trim()) {
      showToast(t('请输入要搜索的内容'), 3000)
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

  /**
   * 过滤 + 分页：在组件级算一次，footer（页码 / 总数）与列表（当前页）共用同一份结果。
   * 以前这段在两个地方各写一遍 —— 改一处漏一处，也正是「筛选不回第 1 页」那类 bug 的土壤。
   */
  const filteredDocs = filterDocuments(
    docs,
    docSearchQuery,
    docSearchMode,
    docSearchResultIds,
  )
  const totalPages = totalPagesOf(filteredDocs.length, PAGE_SIZE)
  const safePage = Math.min(page, totalPages)
  const pageDocs = pageSlice(filteredDocs, page, PAGE_SIZE)

  // 关键词一变就回第 1 页（「按名称」是即时过滤，不回页会看到「筛选结果的第 3 页」）；
  // 清空输入框等于取消筛选 —— 「按内容」的命中 id 也要一起清，否则列表永远恢复不了。
  useEffect(() => {
    setPage(1)
    if (!docSearchQuery.trim()) setDocSearchResultIds(null)
  }, [docSearchQuery])

  // 删文档 / 换筛选后总页数会变小：把 page 收回合法范围（只把 safePage 用于显示的话，
  // 状态会一直停在越界值，下次换个条件又跳到「第 3 页」）
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages))
  }, [totalPages])

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
              {docs.length > 0 && (
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
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                        {t('下一页')}
                      </button>
                    </div>
                  )}
                  <span className="kb-pagination-total">
                    {tpl('共 $__count__ 份文档', { count: docs.length })}
                    {docSearchQuery.trim() &&
                      `，${tpl('筛选出 $__count__ 份', { count: filteredDocs.length })}`}
                  </span>
                </div>
              )}
            </div>
            <div className="kb-doclist-footer-right">
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleUpload}
                title={t(
                  '从电脑里选文件加进来，可一次选多个；纯文本与 PDF 都能读，单个文本不超过 2 MB',
                )}>
                {t('添加文档')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleUploadFolder}
                title={t(
                  '把整个文件夹加进来：能读的文本文件（单个 2 MB 以内）和 PDF 都会读入；.gitignore 排除的、依赖与构建目录（node_modules、dist 之类）会跳过',
                )}>
                {t('添加文件夹')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleImportZip}
                title={t(
                  '把之前导出的压缩包读回来（内容按名字合并）；包里的 .gitignore 同样生效',
                )}>
                {t('导入压缩包')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleExportKb}
                disabled={docs.length === 0}
                title={t(
                  '导出成压缩包：里面是已经读进来的文字内容（不是原来的文件），可再导入到别的库或电脑',
                )}>
                {t('导出')}
              </button>
              <button
                className="kb-btn kb-btn-sm kb-btn-danger"
                onClick={handleClearAllDocs}
                disabled={docs.length === 0 || !!deletingId}
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
                        // 关键词已经填好了就直接搜（不能靠 handleDocSearch 读 state：
                        // 这一 tick 里 docSearchMode 还是 'title'）
                        if (docSearchQuery.trim()) {
                          void runContentSearch(docSearchQuery)
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
                          '把文档、笔记或代码文件加进来（纯文本与 PDF 都能读），AI 回答你的问题时就能查到这些内容。',
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
                              <div className="doc-item-name">{doc.file_name}</div>
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
                                    disabled={!!deletingId}
                                    onClick={() =>
                                      setPreviewTarget({
                                        docId: doc.id,
                                        docName: doc.file_name,
                                      })
                                    }
                                    title={t('看看这份文档里的内容')}>
                                    {t('预览')}
                                  </button>
                                  {doc.memory_detail_of ? (
                                    /* 记忆的详情正文：删它/改它都会让那条记忆的正文静默变样，
                                       后端也会拒 —— 把按钮的位置留给一句说明，别让用户白点。
                                       真正清理它的入口是「删掉那条记忆」（正文会一起清）。*/
                                    <span
                                      className="doc-item-locked"
                                      title={t(
                                        '这份文档是某条记忆的详情正文，删改都要回到记忆那边操作',
                                      )}>
                                      {t('记忆详情')}
                                    </span>
                                  ) : (
                                    <>
                                      <button
                                        className="kb-btn kb-btn-sm"
                                        disabled={!!deletingId}
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
                                        className={`kb-btn kb-btn-sm kb-btn-danger ${
                                          deletingId === doc.id ? 'kb-btn-busy' : ''
                                        }`}
                                        disabled={!!deletingId}
                                        onClick={() =>
                                          handleRemoveDoc(doc.id, doc.file_name)
                                        }>
                                        {deletingId === doc.id
                                          ? t('删除中…')
                                          : t('删除')}
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
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
