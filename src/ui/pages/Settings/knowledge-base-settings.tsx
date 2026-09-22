/**
 * knowledge-base-settings — 知识库管理页面
 *
 * 功能：
 * - RAG 开关 / 默认知识库设置
 * - 知识库创建（弹窗）/ 删除 / 列表
 * - 文档上传 / 删除 / 编辑 / 预览、检索测试（均在 DocListModal 内托管）
 *
 * 拆分说明：弹窗组件与文件导入 / 导出工具已抽到 `./knowledge-base/*`，
 * 本文件只保留 RAG 开关 + 知识库列表 + 两个弹窗的挂载。
 */

import { useEffect, useState, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Select from '@/ui/components/shared/Select'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import type { KnowledgeBase } from '@/domain/ports'
import { rowKeyHandler } from '@/utils/a11y'
import './knowledge-base-settings.scss'
import { showToastMsg } from './knowledge-base/toast'
import { pickUploadFiles, pickUploadFolder } from './knowledge-base/file-import'
import { exportKnowledgeBaseZip } from './knowledge-base/export'
import CreateKbModal from './knowledge-base/CreateKbModal'
import DocListModal from './knowledge-base/DocListModal'

function KnowledgeBaseSettings() {
  const s = settingsState.value
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)

  // 创建知识库弹窗
  const [showCreateModal, setShowCreateModal] = useState(false)

  // 文档列表弹窗（文档 / 搜索 / 分页等 state 由 DocListModal 自持）
  const [showDocListModal, setShowDocListModal] = useState(false)
  const [docListKbId, setDocListKbId] = useState('')
  const [docListKbName, setDocListKbName] = useState('')

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
      showToastMsg(
        tpl('加载知识库失败: $__error__', { error: err.message }),
        'error',
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadKbs()
  }, [loadKbs])

  /** 打开创建知识库弹窗 */
  const openCreateModal = () => {
    setShowCreateModal(true)
  }

  /** 删除知识库 */
  const handleDelete = async (kbId: string, name: string) => {
    const confirmed = await MessageBox.propt(
      t('删除知识库'),
      tpl('确定要删除知识库「$__name__」吗？此操作不可撤销。', { name }),
      { danger: true },
    )
    if (!confirmed) return
    try {
      await ragService.deleteKnowledgeBase(kbId)
      showToastMsg(t('知识库已删除'), 'success')
      if (showDocListModal && docListKbId === kbId) setShowDocListModal(false)
      await loadKbs()
    } catch (err: any) {
      showToastMsg(tpl('删除失败: $__error__', { error: err.message }), 'error')
    }
  }

  /** 打开文档列表弹窗 */
  const openDocListModal = (kbId: string, kbName: string) => {
    setDocListKbId(kbId)
    setDocListKbName(kbName)
    setShowDocListModal(true)
  }

  return (
    <div className="knowledge-base-settings">
      {/* RAG 开关设置 */}
      <div className="kb-section">
        <h3>{t('知识库')}</h3>
        <div className="kb-toggle-row">
          <button
            className={`kb-toggle ${s.ragEnabled ? 'active' : ''}`}
            role="switch"
            aria-checked={s.ragEnabled}
            aria-label={t('知识库检索')}
            onClick={() => {
              const next = !settingsState.value.ragEnabled
              settingsState.setValue('ragEnabled', next)
              ragService.setConfig({ enabled: next })
            }}
            title={s.ragEnabled ? t('关闭 RAG') : t('开启 RAG')}>
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
            <h3 style={{ marginBottom: 0 }}>{t('知识库列表')}</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              ({kbs.length})
            </span>
          </div>
          <div className="kb-header-actions">
            <button
              className="kb-btn kb-btn-primary kb-btn-sm"
              onClick={openCreateModal}>
              {t('创建知识库')}
            </button>
            <button
              className="kb-btn kb-btn-sm"
              onClick={loadKbs}
              disabled={loading}>
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
                    role="button"
                    tabIndex={0}
                    aria-label={kb.name}
                    onClick={() => openDocListModal(kb.id, kb.name)}
                    onKeyDown={rowKeyHandler(() =>
                      openDocListModal(kb.id, kb.name),
                    )}
                    style={{ cursor: 'pointer' }}>
                    <div className="kb-card-name">{kb.name}</div>
                    {kb.description && (
                      <div className="kb-card-desc">{kb.description}</div>
                    )}
                    <div className="kb-card-meta">
                      {kb.document_count} {t('个文档')} · {kb.chunk_count}{' '}
                      {t('个片段')}
                    </div>
                  </div>
                  <div className="kb-card-actions">
                    <button
                      className="kb-btn kb-btn-sm kb-btn-primary"
                      onClick={() => pickUploadFiles(kb.id, loadKbs)}
                      title={t('上传文档到该知识库（支持多选）')}>
                      {t('上传文档')}
                    </button>
                    <button
                      className="kb-btn kb-btn-sm"
                      onClick={() => pickUploadFolder(kb.id, loadKbs)}
                      title={t('上传文件夹，自动导入所有文本文件')}>
                      {t('上传文件夹')}
                    </button>
                    <button
                      className="kb-btn kb-btn-sm"
                      onClick={() => exportKnowledgeBaseZip(kb.id, kb.name)}
                      title={t('导出知识库所有文档为 ZIP')}>
                      {t('导出')}
                    </button>
                    <button
                      className="kb-btn kb-btn-sm kb-btn-danger"
                      onClick={() => handleDelete(kb.id, kb.name)}>
                      {t('删除')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建知识库弹窗 */}
      <CreateKbModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={loadKbs}
      />

      {/* 文档列表弹窗（含预览 / 新建 / 编辑子弹窗、检索测试） */}
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
