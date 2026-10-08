/**
 * knowledge-base-settings — 知识库（设置 → 知识库）：新建 / 删除知识库、把文档加进来、导出备份；
 * 文档级的查看 / 编辑 / 在该库内试搜都在 `DocListModal` 内托管。
 *
 * 三处口径，都是为了「不用先配好才能用」：
 * - 知识库**固定启用**：它自己不占资源、不后台跑东西，文档只在你提问时才被查找，所以没有总开关；
 * - **没有「默认知识库」**：查哪个库由当下的场景决定（导入会话时选库、在这个库里搜的就是这个库），
 *   少一个「配错了会静默查错地方」的设置；
 * - 文案说人话：不出现 RAG / 分块 / chunk / 向量这类实现词 —— 用户放进去的是**文档**，
 *   AI 会「先在这里查一遍」。
 *
 * 还有一件事：**系统自建的库（默认知识库 / 记忆详情）不给删**。它们由功能自己创建与维护，
 * 删掉只会让对应功能静默失效（记忆条目指向的详情库就没了）—— 所以卡片上不画删除按钮，
 * 改成一句说明；后端也会拒（见 `rag::vector_store::delete_knowledge_base`）。
 */
import { useEffect, useState, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import type { KnowledgeBase } from '@/domain/ports'
import './knowledge-base-settings.scss'
import { showToastMsg } from './knowledge-base/toast'
import { pickUploadFiles, pickUploadFolder } from './knowledge-base/file-import'
import { exportKnowledgeBaseZip } from './knowledge-base/export'
import CreateKbModal from './knowledge-base/CreateKbModal'
import DocListModal from './knowledge-base/DocListModal'

function KnowledgeBaseSettings() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)

  const [showCreateModal, setShowCreateModal] = useState(false)

  // 文档列表弹窗（文档 / 搜索 / 分页等 state 由 DocListModal 自持）
  const [showDocListModal, setShowDocListModal] = useState(false)
  const [docListKbId, setDocListKbId] = useState('')
  const [docListKbName, setDocListKbName] = useState('')

  const loadKbs = useCallback(async () => {
    setLoading(true)
    try {
      const list = await ragService.listKnowledgeBases()
      setKbs(list)
    } catch (err: any) {
      showToastMsg(
        tpl('读不到知识库列表：$__error__', { error: err.message }),
        'error',
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadKbs()
  }, [loadKbs])

  const totalDocs = kbs.reduce((n, kb) => n + (kb.document_count || 0), 0)
  const totalChunks = kbs.reduce((n, kb) => n + (kb.chunk_count || 0), 0)

  const openDocListModal = useCallback((kbId: string, kbName: string) => {
    setDocListKbId(kbId)
    setDocListKbName(kbName)
    setShowDocListModal(true)
  }, [])

  const handleDelete = async (kbId: string, name: string) => {
    const confirmed = await MessageBox.propt(
      t('删除知识库'),
      tpl(
        '删除「$__name__」后，它里面的文档和已建立的内容都会一起删除，无法恢复。',
        { name },
      ),
      { danger: true, confirmText: t('删除') },
    )
    if (!confirmed) return
    try {
      await ragService.deleteKnowledgeBase(kbId)
      showToastMsg(t('知识库已删除'), 'success')
      if (showDocListModal && docListKbId === kbId) setShowDocListModal(false)
      await loadKbs()
    } catch (err: any) {
      showToastMsg(tpl('删除失败：$__error__', { error: err.message }), 'error')
    }
  }

  return (
    <div className="knowledge-base-settings">
      <header className="kb-page-header">
        <div className="kb-page-header-text">
          <h2 className="section-title">{t('知识库')}</h2>
          <p className="kb-page-desc">
            {t(
              '把常用的文档、笔记放进来，AI 回答时会先在这里查一遍。内容只保存在这台电脑上。',
            )}
          </p>
        </div>
        <button
          className="kb-btn kb-btn-primary"
          onClick={() => setShowCreateModal(true)}>
          {t('新建知识库')}
        </button>
      </header>

      {loading && kbs.length === 0 ? (
        <div className="kb-skeleton" aria-busy="true" aria-label={t('加载中…')}>
          <div className="kb-skeleton-card" />
          <div className="kb-skeleton-card" />
        </div>
      ) : kbs.length === 0 ? (
        <div className="kb-empty">
          <div className="kb-empty-title">{t('还没有知识库')}</div>
          <p className="kb-empty-desc">
            {t(
              '新建一个，把项目文档、规范或资料放进去 —— 之后问 AI 时，它会先翻这些内容再回答。',
            )}
          </p>
          <button
            className="kb-btn kb-btn-primary"
            onClick={() => setShowCreateModal(true)}>
            {t('新建知识库')}
          </button>
        </div>
      ) : (
        <>
          <div className="kb-list-summary">
            {tpl('$__kb__ 个知识库 · 共 $__docs__ 份文档', {
              kb: kbs.length,
              docs: totalDocs,
            })}
            {totalChunks > 0 &&
              ` · ${tpl('$__chunks__ 段内容可被查找', { chunks: totalChunks })}`}
          </div>

          <div className="kb-list">
            {kbs.map((kb) => (
              <article className="kb-card" key={kb.id}>
                <button
                  type="button"
                  className="kb-card-main"
                  onClick={() => openDocListModal(kb.id, kb.name)}
                  title={t('查看和管理这个知识库里的文档')}>
                  <span className="kb-card-name">
                    {kb.name}
                    {kb.builtin && (
                      <span
                        className="kb-card-badge"
                        title={t('由 Virlen 自动创建并维护，不能删除')}>
                        {t('自动创建')}
                      </span>
                    )}
                  </span>
                  {kb.description && (
                    <span className="kb-card-desc">{kb.description}</span>
                  )}
                  <span className="kb-card-meta">
                    <span>
                      {tpl('$__docs__ 份文档 · $__chunks__ 段内容', {
                        docs: kb.document_count || 0,
                        chunks: kb.chunk_count || 0,
                      })}
                    </span>
                    <span className="kb-card-open">
                      {t('查看文档')} <span aria-hidden="true">›</span>
                    </span>
                  </span>
                </button>
                <div className="kb-card-actions">
                  <button
                    className="kb-btn kb-btn-sm kb-btn-primary"
                    onClick={() => pickUploadFiles(kb.id, loadKbs)}
                    title={t('从电脑里选文档加进来，可一次选多个')}>
                    {t('添加文档')}
                  </button>
                  <button
                    className="kb-btn kb-btn-sm"
                    onClick={() => pickUploadFolder(kb.id, loadKbs)}
                    title={t(
                      '把整个文件夹加进来，里面的 Markdown / TXT 会自动读入',
                    )}>
                    {t('添加文件夹')}
                  </button>
                  <button
                    className="kb-btn kb-btn-sm"
                    onClick={() => exportKnowledgeBaseZip(kb.id, kb.name)}
                    title={t('导出成压缩包，方便备份或换到别的电脑')}>
                    {t('导出')}
                  </button>
                  {kb.builtin ? (
                    // 系统自建库：删除按钮的位置留给一句说明 —— 否则用户会先找「为什么没有删除」
                    // （悬停也给同一句原因，不必先去猜那个「自动创建」小标）
                    <span
                      className="kb-card-locked"
                      title={t('由 Virlen 自动创建并维护，不能删除')}>
                      {t('不能删除')}
                    </span>
                  ) : (
                    <button
                      className="kb-btn kb-btn-sm kb-btn-danger"
                      onClick={() => handleDelete(kb.id, kb.name)}
                      title={t('删除这个知识库和里面的全部文档')}>
                      {t('删除')}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <CreateKbModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={loadKbs}
      />

      {/* 文档列表弹窗（含预览 / 新建 / 编辑子弹窗、在当前库内试搜） */}
      <DocListModal
        visible={showDocListModal}
        kbId={docListKbId}
        kbName={docListKbName}
        onClose={() => setShowDocListModal(false)}
        onChanged={loadKbs}
      />
    </div>
  )
}

export default observer(KnowledgeBaseSettings)
