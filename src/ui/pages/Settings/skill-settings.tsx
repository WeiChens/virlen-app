/**
 * skill-settings — 技能管理页面
 *
 * 功能：
 *  - 查看所有已注册技能
 *  - 导入技能 ZIP 包
 *  - 删除技能
 *  - 刷新技能元信息
 *  - 查看 SKILLs 目录路径
 */
import { useState, useEffect, useMemo } from 'react'
import { observer } from 'mobx-react-lite'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import Modal from '@/ui/components/shared/Modal'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import {
  listRegisteredSkills,
  deleteSkill,
  refreshSkillsMeta,
  scanAndRegisterSkills,
  importSkillFromZipDialog,
  getSkillsDirPath,
  readSkillMd,
} from '@/skill'
import type { RegisteredSkill } from '@/skill/types'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import AddSvg from '@/ui/components/icons/AddSvg'
import { t, tpl, getCurrentLanguage } from '@/ui/i18n'
import './skill-settings.scss'
import { openPath } from '@tauri-apps/plugin-opener'

function SkillSettings() {
  const [skills, setSkills] = useState<RegisteredSkill[]>([])
  const [skillsDirPath, setSkillsDirPath] = useState(t('加载中...'))
  const [importing, setImporting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // SKILL.md 预览弹窗
  const [previewSkill, setPreviewSkill] = useState<RegisteredSkill | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

  // 模糊搜索：匹配 name 或 description
  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.meta.name.toLowerCase().includes(q) ||
        s.meta.description.toLowerCase().includes(q),
    )
  }, [skills, searchQuery])

  // 加载数据
  useEffect(() => {
    loadSkills()
    getSkillsDirPath()
      .then((p) => setSkillsDirPath(p))
      .catch(() => setSkillsDirPath(t('无法获取路径')))
  }, [])

  function loadSkills() {
    setSkills(listRegisteredSkills())
  }

  // 导入 ZIP
  async function handleImport() {
    setImporting(true)
    try {
      const names = await importSkillFromZipDialog()
      if (names.length > 0) {
        showToast(
          tpl('成功导入 $__count__ 个技能：$__names__', {
            count: names.length,
            names: names.join(', '),
          }),
          2000,
        )
        loadSkills()
      } else {
        showToast(t('未导入任何技能'), 1000)
      }
    } catch (e: any) {
      showToast(
        tpl('导入失败: $__error__', { error: e.message || String(e) }),
        2000,
      )
    } finally {
      setImporting(false)
    }
  }

  // 扫描注册
  async function handleScan() {
    setRefreshing(true)
    try {
      const newly = await scanAndRegisterSkills()
      if (newly.length > 0) {
        showToast(
          tpl('扫描到 $__count__ 个新技能', { count: newly.length }),
          1500,
        )
      } else {
        showToast(t('未发现新技能'), 1000)
      }
      loadSkills()
    } catch (e: any) {
      showToast(
        tpl('扫描失败: $__error__', { error: e.message || String(e) }),
        1500,
      )
    } finally {
      setRefreshing(false)
    }
  }

  // 刷新元信息
  async function handleRefresh() {
    setRefreshing(true)
    try {
      await refreshSkillsMeta()
      showToast(t('技能元信息已刷新'), 1000)
      loadSkills()
    } catch (e: any) {
      showToast(
        tpl('刷新失败: $__error__', { error: e.message || String(e) }),
        1500,
      )
    } finally {
      setRefreshing(false)
    }
  }

  // 删除技能
  async function handleDelete(skill: RegisteredSkill) {
    const confirmed = await MessageBox.propt(
      t('删除技能'),
      tpl('确定删除「$__name__」？技能文件将从磁盘永久删除。', {
        name: skill.meta.name,
      }),
      { confirmText: t('删除'), cancelText: t('取消') },
    )
    if (!confirmed) return
    const ok = await deleteSkill(skill.meta.name)
    if (ok) {
      showToast(t('已删除'), 1000)
      loadSkills()
    }
  }

  // 预览 SKILL.md
  async function handlePreview(skill: RegisteredSkill) {
    setPreviewSkill(skill)
    setPreviewContent('')
    setPreviewLoading(true)
    try {
      const md = await readSkillMd(skill.meta.name)
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

  // 打开技能目录
  async function openSkillsDir() {
    try {
      await openPath(skillsDirPath)
    } catch {
      showToast(t('请在文件管理器中手动打开: ') + skillsDirPath, 2000)
    }
  }

  return (
    <div className="skill-settings">
      <div className="skill-header">
        <div className="left">
          <h2 className="section-title">{t('技能管理')}</h2>
          <p
            className="skill-path"
            onClick={openSkillsDir}
            title={t('点击打开目录')}>
            <FolderSvg fill="var(--text-secondary, #888)" />
            <span>{skillsDirPath}</span>
          </p>
        </div>
        <div className="skill-actions">
          <button
            className="skill-action-btn"
            onClick={handleScan}
            disabled={refreshing}>
            {t('扫描')}
          </button>
          <button
            className="skill-action-btn"
            onClick={handleRefresh}
            disabled={refreshing}>
            {t('刷新元信息')}
          </button>
          <button
            className="skill-import-btn"
            onClick={handleImport}
            disabled={importing}>
            <AddSvg />
            <span>{importing ? t('导入中...') : t('导入 ZIP')}</span>
          </button>
        </div>
      </div>

      {/* 搜索 & 计数 */}
      <div className="skill-search-row">
        <span className="skill-count">
          {tpl('共 $__count__ 个技能', { count: skills.length })}
          {searchQuery.trim() && filteredSkills.length !== skills.length
            ? tpl('，匹配 $__count__ 个', { count: filteredSkills.length })
            : ''}
        </span>
        <input
          className="skill-search-input"
          type="text"
          placeholder={t('搜索技能名称或描述…')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="skill-list">
        {filteredSkills.map((skill) => (
          <div
            key={skill.meta.name}
            className="skill-item"
            onClick={() => handlePreview(skill)}>
            <div className="skill-item-main">
              <div className="skill-item-name-row">
                <span className="skill-item-name">{skill.meta.name}</span>
                {skill.meta.version && (
                  <span className="skill-item-version">
                    v{skill.meta.version}
                  </span>
                )}
              </div>
              <span className="skill-item-desc">{skill.meta.description}</span>
              <div className="skill-item-footer">
                {skill.meta.tags && skill.meta.tags.length > 0 && (
                  <div className="skill-tags">
                    {skill.meta.tags.map((tag) => (
                      <span key={tag} className="skill-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <span className="skill-item-time">
                  {tpl('注册于 $__date__', {
                    date: new Date(skill.registeredAt).toLocaleString(
                      getCurrentLanguage(),
                    ),
                  })}
                </span>
              </div>
            </div>
            <div
              className="skill-item-actions"
              onClick={(e) => e.stopPropagation()}>
              <button
                className="skill-action-btn danger"
                onClick={() => handleDelete(skill)}>
                {t('删除')}
              </button>
            </div>
          </div>
        ))}

        {filteredSkills.length === 0 && skills.length === 0 && (
          <div className="skill-empty">
            <FolderSvg fill="var(--text-secondary, #ccc)" />
            <p>{t('暂无注册的技能')}</p>
            <p className="skill-empty-hint">
              {t(
                '点击「导入 ZIP」导入技能包，或手动将技能文件夹放入上述目录后点击「扫描」',
              )}
            </p>
          </div>
        )}
        {filteredSkills.length === 0 && skills.length > 0 && (
          <div className="skill-empty">
            <p>
              {t('未找到匹配')}「{searchQuery}」{t('的技能')}
            </p>
          </div>
        )}
      </div>

      {/* SKILL.md 预览弹窗 */}
      <Modal
        visible={!!previewSkill}
        title={previewSkill ? `SKILL.md — ${previewSkill.meta.name}` : ''}
        onClose={handleClosePreview}
        width={720}
        height="80vh"
        showCloseButton
        closeOnClickOutside>
        {previewLoading ? (
          <div className="loading-state">{t('加载中…')}</div>
        ) : (
          <MarkdownRenderer content={previewContent} />
        )}
      </Modal>
    </div>
  )
}

export default observer(SkillSettings)
