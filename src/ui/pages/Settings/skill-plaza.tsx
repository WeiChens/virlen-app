/**
 * skill-plaza — 技能广场页面
 *
 * 功能：
 *  - 从远程 API 拉取已发布的技能列表
 *  - 分类筛选 + 关键词搜索 + 分页
 *  - 点击技能卡片 → 预览 SKILL.md
 *  - 导入技能到本地（下载 ZIP → 安装）
 */
import { useState, useEffect, useMemo } from 'react'
import { observer } from 'mobx-react-lite'
import { showToast } from '@/ui/components/shared/Toast'
import Modal from '@/ui/components/shared/Modal'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import {
  fetchPlazaSkills,
  fetchPlazaCategories,
  fetchPlazaSkillReadme,
  importSkillFromPlaza,
  isSkillInstalled,
} from '@/skill'
import type { RemoteSkill, RemoteCategory } from '@/skill'
import SearchSvg from '@/ui/components/icons/SearchSvg'
import AddSvg from '@/ui/components/icons/AddSvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import { t, tpl } from '@/ui/i18n'
import './skill-plaza.scss'

function SkillPlaza() {
  // ==================== 数据 ====================
  const [skills, setSkills] = useState<RemoteSkill[]>([])
  const [categories, setCategories] = useState<RemoteCategory[]>([])
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | undefined>(undefined)
  const [pagination, setPagination] = useState<Pick<PaginatedData<RemoteSkill>, 'total' | 'page' | 'page_size' | 'total_pages'>>({
    total: 0, page: 1, page_size: 20, total_pages: 0,
  })

  // 预览弹窗
  const [previewSkill, setPreviewSkill] = useState<RemoteSkill | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

  // 导入状态
  const [importingSkillId, setImportingSkillId] = useState<number | null>(null)

  // ==================== 初始化 ====================
  useEffect(() => {
    fetchCategories()
    fetchSkills()
  }, [])

  // ==================== 数据获取 ====================
  async function fetchCategories() {
    try {
      const cats = await fetchPlazaCategories()
      setCategories(cats)
    } catch {
      // 分类获取失败不影响主流程
    }
  }

  async function fetchSkills() {
    setLoading(true)
    setErrorMsg('')
    try {
      const params: { page: number; page_size: number; keyword?: string; category_id?: number } = {
        page: pagination.page,
        page_size: pagination.page_size,
      }
      if (searchKeyword) params.keyword = searchKeyword
      if (selectedCategoryId) params.category_id = selectedCategoryId

      const result = await fetchPlazaSkills(params)
      setSkills(result.data)
      setPagination({
        total: result.total,
        page: result.page,
        page_size: result.page_size,
        total_pages: result.total_pages,
      })
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : t('获取技能列表失败'))
    } finally {
      setLoading(false)
    }
  }

  // ==================== 搜索 & 筛选 ====================
  function doSearch() {
    setSearchKeyword(keyword)
    setPagination(prev => ({ ...prev, page: 1 }))
    fetchSkills()
  }

  function clearSearch() {
    setKeyword('')
    setSearchKeyword('')
    setPagination(prev => ({ ...prev, page: 1 }))
    fetchSkills()
  }

  function selectCategory(id?: number) {
    setSelectedCategoryId(id)
    setPagination(prev => ({ ...prev, page: 1 }))
    fetchSkills()
  }

  // ==================== 分页 ====================
  function goToPage(p: number) {
    if (p < 1 || p > pagination.total_pages) return
    setPagination(prev => ({ ...prev, page: p }))
    fetchSkills()
  }

  const visiblePages = useMemo(() => {
    const tp = pagination.total_pages
    const cur = pagination.page
    if (tp <= 7) return Array.from({ length: tp }, (_, i) => i + 1)
    const pages: (number | string)[] = [1]
    if (cur > 3) pages.push('...')
    const start = Math.max(2, cur - 1)
    const end = Math.min(tp - 1, cur + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    if (cur < tp - 2) pages.push('...')
    pages.push(tp)
    return pages
  }, [pagination.total_pages, pagination.page])

  // ==================== 预览 ====================
  async function handlePreview(skill: RemoteSkill) {
    setPreviewSkill(skill)
    setPreviewContent('')
    setPreviewLoading(true)
    try {
      const md = await fetchPlazaSkillReadme(skill.id)
      setPreviewContent(md)
    } catch (e: any) {
      setPreviewContent(`# ${t('读取失败')}\n\n${e.message || String(e)}`)
    } finally {
      setPreviewLoading(false)
    }
  }

  function handleClosePreview() {
    setPreviewSkill(null)
    setPreviewContent('')
  }

  // ==================== 导入 ====================
  async function handleImport(skill: RemoteSkill) {
    setImportingSkillId(skill.id)
    try {
      const name = await importSkillFromPlaza(skill.id)
      showToast(tpl('成功导入技能「$__name__」', { name }), 2000)
    } catch (e: any) {
      showToast(tpl('导入失败: $__error__', { error: e.message || String(e) }), 3000)
    } finally {
      setImportingSkillId(null)
    }
  }

  // ==================== 辅助 ====================
  function fmtDownloads(count: number): string {
    if (count >= 10000) return (count / 10000).toFixed(1) + 'w'
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k'
    return String(count)
  }

  function fmtFileSize(bytes?: number | null): string {
    if (!bytes) return ''
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB'
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + 'KB'
    return bytes + 'B'
  }

  // ==================== 渲染 ====================
  return (
    <div className="skill-plaza">
      {/* 搜索栏 */}
      <div className="plaza-search-row">
        <div className="plaza-search-box">
          <SearchSvg fill="var(--text-secondary)" />
          <input
            type="text"
            placeholder={t('搜索技能名称或描述…')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            autoComplete="off"
          />
          {searchKeyword && (
            <button className="plaza-search-clear" onClick={clearSearch}>✕</button>
          )}
        </div>
        <button className="plaza-search-btn" onClick={doSearch}>
          {t('搜索')}
        </button>
      </div>

      {/* 分类筛选 */}
      {categories.length > 0 && (
        <div className="plaza-categories">
          <button
            className={`plaza-cat-btn ${!selectedCategoryId ? 'active' : ''}`}
            onClick={() => selectCategory()}>
            {t('全部')}
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`plaza-cat-btn ${selectedCategoryId === cat.id ? 'active' : ''}`}
              onClick={() => selectCategory(cat.id)}>
              {cat.name}
              <span className="plaza-cat-count">{cat.skill_count}</span>
            </button>
          ))}
        </div>
      )}

      {/* 内容区 */}
      <div className="plaza-content">
        {/* 加载中 */}
        {loading && (
          <div className="plaza-state">
            <div className="plaza-spinner" />
            <p>{t('加载中…')}</p>
          </div>
        )}

        {/* 错误 */}
        {!loading && errorMsg && (
          <div className="plaza-state plaza-state-error">
            <p>{errorMsg}</p>
            <button className="plaza-retry-btn" onClick={fetchSkills}>
              {t('重试')}
            </button>
          </div>
        )}

        {/* 有数据 */}
        {!loading && !errorMsg && skills.length > 0 && (
          <>
            {/* 统计 */}
            <div className="plaza-result-info">
              <span>
                {tpl('共 $__count__ 个技能', { count: pagination.total })}
                {selectedCategoryId && (
                  <span className="plaza-result-cat">
                    {categories.find((c) => c.id === selectedCategoryId)?.name}
                    <span
                      className="plaza-result-cat-x"
                      onClick={() => selectCategory()}>
                      ✕
                    </span>
                  </span>
                )}
              </span>
            </div>

            {/* 技能卡片列表 */}
            <div className="plaza-card-list">
              {skills.map((skill) => {
                const installed = isSkillInstalled(skill.name)
                const isImporting = importingSkillId === skill.id

                return (
                  <div
                    key={skill.id}
                    className="plaza-card"
                    onClick={() => handlePreview(skill)}>
                    <div className="plaza-card-header">
                      <div className="plaza-card-icon">🧩</div>
                      <div className="plaza-card-info">
                        <span className="plaza-card-name">{skill.name}</span>
                        {skill.version && (
                          <span className="plaza-card-ver">
                            v{skill.version}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="plaza-card-desc">
                      {skill.description || t('暂无描述')}
                    </p>
                    <div className="plaza-card-meta">
                      {skill.tags && skill.tags.length > 0 && (
                        <div className="plaza-card-tags">
                          {skill.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="plaza-tag">{tag}</span>
                          ))}
                          {skill.tags.length > 3 && (
                            <span className="plaza-tag-more">
                              +{skill.tags.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="plaza-card-stats">
                        {skill.author && (
                          <span className="plaza-stat">
                            👤 {skill.author.length > 10 ? skill.author.slice(0, 10) + '…' : skill.author}
                          </span>
                        )}
                        <span className="plaza-stat">
                          ⬇ {fmtDownloads(skill.download_count)}
                        </span>
                        {skill.file_size && (
                          <span className="plaza-stat">
                            📦 {fmtFileSize(skill.file_size)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="plaza-card-footer">
                      {installed ? (
                        <span className="plaza-installed-badge">
                          ✓ {t('已安装')}
                        </span>
                      ) : (
                        <button
                          className="plaza-import-btn"
                          disabled={isImporting}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleImport(skill)
                          }}>
                          {isImporting ? (
                            <>
                              <div className="plaza-mini-spinner" />
                              {t('导入中…')}
                            </>
                          ) : (
                            <>
                              <AddSvg fill="#fff" />
                              {t('导入')}
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 分页 */}
            {pagination.total_pages > 1 && (
              <div className="plaza-pagination">
                <button
                  className="page-btn"
                  disabled={pagination.page <= 1}
                  onClick={() => goToPage(pagination.page - 1)}>
                  ‹
                </button>
                {visiblePages.map((p, idx) =>
                  p === '...' ? (
                    <span key={idx} className="page-ellipsis">…</span>
                  ) : (
                    <button
                      key={idx}
                      className={`page-btn ${p === pagination.page ? 'active' : ''}`}
                      onClick={() => goToPage(p as number)}>
                      {p}
                    </button>
                  ),
                )}
                <button
                  className="page-btn"
                  disabled={pagination.page >= pagination.total_pages}
                  onClick={() => goToPage(pagination.page + 1)}>
                  ›
                </button>
              </div>
            )}
          </>
        )}

        {/* 空状态 */}
        {!loading && !errorMsg && skills.length === 0 && (
          <div className="plaza-state">
            <FolderSvg fill="var(--text-secondary, #ccc)" />
            <p>{t('暂无已发布的技能')}</p>
          </div>
        )}
      </div>

      {/* SKILL.md 预览弹窗 */}
      <Modal
        visible={!!previewSkill}
        title={previewSkill ? `${previewSkill.name} — SKILL.md` : ''}
        onClose={handleClosePreview}
        width={720}
        height="80vh"
        showCloseButton
        closeOnClickOutside
        footer={
          previewSkill && !isSkillInstalled(previewSkill.name) ? (
            <div className="plaza-preview-footer">
              <button
                className="plaza-preview-import-btn"
                disabled={importingSkillId === previewSkill.id}
                onClick={() => handleImport(previewSkill)}>
                {importingSkillId === previewSkill.id
                  ? t('导入中…')
                  : tpl('导入「$__name__」', { name: previewSkill.name })}
              </button>
            </div>
          ) : previewSkill && isSkillInstalled(previewSkill.name) ? (
            <div className="plaza-preview-footer">
              <span className="plaza-installed-badge">
                ✓ {t('已安装')}
              </span>
            </div>
          ) : undefined
        }>
        {previewLoading ? (
          <div className="plaza-preview-loading">{t('加载中…')}</div>
        ) : (
          <MarkdownRenderer content={previewContent} />
        )}
      </Modal>
    </div>
  )
}

export default observer(SkillPlaza)
