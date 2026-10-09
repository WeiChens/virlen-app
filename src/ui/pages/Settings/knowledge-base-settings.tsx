/**
 * knowledge-base-settings — 知识库（设置 → 知识库）：列表里的库只做「新建 / 改名 / 删除」三件事，
 * 点卡片进 `DocListModal`，文档的查看 / 新建 / 编辑 / 删除与该库内的试搜、导出、导入全在里面。
 *
 * 卡片上不摆文档级动作（添加文档 / 添加文件夹 / 导入压缩包 / 导出那些），是为了让一行只剩
 * 「进」「改名」「删」三种意图：左边一块（信息 + 行尾箭头）负责进，竖线右边一块只放库级动作，
 * 不混在一起。
 *
 * 三处口径，都是为了「不用先配好才能用」：
 * - 知识库**固定启用**：它自己不占资源、不后台跑东西，文档只在你提问时才被查找，所以没有总开关；
 * - **没有「默认知识库」**：查哪个库由当下的场景决定（导入会话时选库、在这个库里搜的就是这个库），
 *   少一个「配错了会静默查错地方」的设置；
 * - 文案说人话：不出现 RAG / 分块 / chunk / 向量这类实现词 —— 用户放进去的是**文档**，
 *   AI 会「先在这里查一遍」。
 *
 * 还有一件事：**系统自建的库（默认知识库 / 记忆详情）不给改名也不给删**。它们由功能自己创建
 * 与维护，名字是这两个功能的「认领锚点」（缓存失效后按名字找回自己的库），删掉只会让对应
 * 功能静默失效（记忆条目指向的详情库就没了）—— 所以卡片上不画这两个按钮，改成一句说明；
 * 后端也会拒（见 `rag::vector_store::delete_knowledge_base` / `update_knowledge_base`）。
 *
 * 删库要等一会儿（整个库连同里面的文档 / 内容一起清掉，比删一份文档慢得多），所以卡片上的
 * 删除按钮会切「删除中…」并禁用整张卡片的动作（`deletingKbId`）：不然用户会以为没点上。
 */
import { useEffect, useState, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import type { KnowledgeBase } from '@/domain/ports'
import './knowledge-base-settings.scss'
// 文档级的动作（选择文件 / 选文件夹 / 导入压缩包 / 导出）都在 DocListModal 里，本页不再直接用它们
import CreateKbModal from './knowledge-base/CreateKbModal'
import EditKbModal from './knowledge-base/EditKbModal'
import DocListModal from './knowledge-base/DocListModal'

function KnowledgeBaseSettings() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)

  const [showCreateModal, setShowCreateModal] = useState(false)

  // 改名弹窗的目标（null = 关闭）
  const [renameTarget, setRenameTarget] = useState<KnowledgeBase | null>(null)

  // 正在删的库（卡片上的删除按钮切「删除中…」并禁用整张卡片的动作；删除要花时间，不能没反馈）
  const [deletingKbId, setDeletingKbId] = useState<string | null>(null)

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
      showToast(
        tpl('读不到知识库列表：$__error__', { error: err.message }),
        3000,
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
    if (deletingKbId) return
    const confirmed = await MessageBox.propt(
      t('删除知识库'),
      tpl(
        '删除「$__name__」后，它里面的文档和已建立的内容都会一起删除，无法恢复。',
        { name },
      ),
      { danger: true, confirmText: t('删除') },
    )
    if (!confirmed) return
    // 确认之后才切「删除中…」：确认框还弹着就显示它，用户又点取消，那一幕是骗人的
    setDeletingKbId(kbId)
    try {
      await ragService.deleteKnowledgeBase(kbId)
      showToast(t('知识库已删除'))
      await loadKbs()
    } catch (err: any) {
      showToast(tpl('删除失败：$__error__', { error: err.message }), 3000)
    } finally {
      setDeletingKbId(null)
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
                {/* 主体区是**真按钮**（不是 div + role=button）：Tab 能到达、Enter 能触发。
                    横排「信息列 + 行尾箭头」：箭头在按钮内部右端、整行垂直居中，比把
                    「查看文档 ›」塞在信息行尾更像「从这里进下一层」（与记忆页的入口卡同一套语言），
                    也不会和右边的删除挤在同一处行尾。 */}
                <button
                  type="button"
                  className="kb-card-main"
                  disabled={deletingKbId === kb.id}
                  onClick={() => openDocListModal(kb.id, kb.name)}
                  title={t('查看和管理这个知识库里的文档')}>
                  <span className="kb-card-info">
                    {/* 名称自己吃剩余宽度并省略，小标不压缩 —— 名字长时小标不能被挤出卡片 */}
                    <span className="kb-card-title">
                      <span className="kb-card-name">{kb.name}</span>
                      {kb.builtin && (
                        <span
                          className="kb-card-badge"
                          title={t('由 Virlen 自动创建并维护，不能改名或删除')}>
                          {t('自动创建')}
                        </span>
                      )}
                    </span>
                    {kb.description && (
                      <span className="kb-card-desc">{kb.description}</span>
                    )}
                    <span className="kb-card-meta">
                      {tpl('$__docs__ 份文档 · $__chunks__ 段内容', {
                        docs: kb.document_count || 0,
                        chunks: kb.chunk_count || 0,
                      })}
                    </span>
                  </span>
                  <span className="kb-card-arrow" aria-hidden="true">
                    ›
                  </span>
                </button>
                <div className="kb-card-actions">
                  {kb.builtin ? (
                    // 系统自建库：改名 / 删除按钮的位置留给一句说明 —— 否则用户会先找
                    //「为什么这一行没有改名和删除」（悬停也给同一句原因，不必先猜那个「自动创建」小标）
                    <span
                      className="kb-card-locked"
                      title={t('由 Virlen 自动创建并维护，不能改名或删除')}>
                      {t('不能改')}
                    </span>
                  ) : (
                    <>
                      <button
                        className="kb-btn kb-btn-sm"
                        disabled={!!deletingKbId}
                        onClick={() => setRenameTarget(kb)}
                        title={t('改个名字，或补一句说明')}>
                        {t('改名')}
                      </button>
                      <button
                        className={`kb-btn kb-btn-sm kb-btn-danger ${
                          deletingKbId === kb.id ? 'kb-btn-busy' : ''
                        }`}
                        disabled={!!deletingKbId}
                        onClick={() => handleDelete(kb.id, kb.name)}
                        title={t('删除这个知识库和里面的全部文档')}>
                        {deletingKbId === kb.id ? t('删除中…') : t('删除')}
                      </button>
                    </>
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

      {/* 改名弹窗：只对手建的库开放（builtin 的卡片上根本不画这个入口） */}
      <EditKbModal
        visible={!!renameTarget}
        kbId={renameTarget?.id ?? ''}
        kbName={renameTarget?.name ?? ''}
        kbDescription={renameTarget?.description ?? ''}
        onClose={() => setRenameTarget(null)}
        onSaved={loadKbs}
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
