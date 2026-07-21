/**
 * settings-view — 设置面板主入口
 * 包含 通用设置 / Provider 管理 / 安全 / Agent 管理 四个子页面
 * 从新的 store (settingsState) 读取/写入
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import GeneralSettings from './general-settings'
import ProviderSettings from './provider-settings'
import SecuritySettings from './security-settings'
import AgentSettings from './agent-settings'
import SkillSettings from './skill-settings'
import QuickInputSettings from './quickinput-settings'
import SearchEngineSettings from './search-engine-settings'
import KnowledgeBaseSettings from './knowledge-base-settings'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import SettingSvg from '@/ui/components/icons/SettingSvg'
import SystemSvg from '@/ui/components/icons/SystemSvg'
import LockSvg from '@/ui/components/icons/LockSvg'
import AgentSvg from '@/ui/components/icons/AgentSvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import QuickInputSvg from '@/ui/components/icons/QuickInputSvg'
import SearchSvg from '@/ui/components/icons/SearchSvg'
import settingsEvent from '@/events/settingsEvent'
import { t } from '@/ui/i18n'
import './settings-view.scss'

export type SettingsPage =
  | 'general'
  | 'provider'
  | 'security'
  | 'agent'
  | 'skill'
  | 'quickinput'
  | 'search-engine'
  | 'knowledge-base'

export default function SettingsView() {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [page, setPage] = useState<SettingsPage>('general')
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(() => {
    const unlisten = settingsEvent.on('openSettings', (targetPage) => {
      setClosing(false)
      setPage(targetPage as SettingsPage)
      setOpen(true)
    })
    return unlisten
  }, [])

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, 200)
  }, [closing])

  // 组件卸载时清除定时器
  useEffect(() => {
    return () => clearTimeout(closeTimerRef.current)
  }, [])

  if (!open && !closing) {
    return (
      <button
        className="settings-trigger"
        onClick={() => setOpen(true)}
        title={t('设置')}>
        <SettingSvg />
      </button>
    )
  }

  return (
    <div
      className={`settings-overlay${closing ? ' closing' : ''}`}
      onClick={handleClose}>
      <div
        className={`settings-panel${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-sidebar-header">
            <h3>{t('设置')}</h3>
            <button className="close-btn" onClick={handleClose}>
              <CloseSvg />
            </button>
          </div>
          <nav className="settings-nav">
            <button
              className={`nav-item ${page === 'general' ? 'active' : ''}`}
              onClick={() => setPage('general')}>
              <SystemSvg fill="var(--nav-item-color)" />
              <span>{t('通用')}</span>
            </button>
            <button
              className={`nav-item ${page === 'agent' ? 'active' : ''}`}
              onClick={() => setPage('agent')}>
              <AgentSvg fill="var(--nav-item-color)" />
              <span>{t('Agent')}</span>
            </button>
            <button
              className={`nav-item ${page === 'provider' ? 'active' : ''}`}
              onClick={() => setPage('provider')}>
              <SettingSvg fill="var(--nav-item-color)" />
              <span>{t('模型服务')}</span>
            </button>
            <button
              className={`nav-item ${page === 'security' ? 'active' : ''}`}
              onClick={() => setPage('security')}>
              <LockSvg fill="var(--nav-item-color)" />
              <span>{t('安全')}</span>
            </button>
            <button
              className={`nav-item ${page === 'skill' ? 'active' : ''}`}
              onClick={() => setPage('skill')}>
              <FolderSvg fill="var(--nav-item-color)" />
              <span>{t('技能')}</span>
            </button>
            <button
              className={`nav-item ${page === 'quickinput' ? 'active' : ''}`}
              onClick={() => setPage('quickinput')}>
              <QuickInputSvg fill="var(--nav-item-color)" />
              <span>{t('快捷输入')}</span>
            </button>
            <button
              className={`nav-item ${page === 'search-engine' ? 'active' : ''}`}
              onClick={() => setPage('search-engine')}>
              <SearchSvg fill="var(--nav-item-color)" />
              <span>{t('搜索引擎')}</span>
            </button>
            <button
              className={`nav-item ${page === 'knowledge-base' ? 'active' : ''}`}
              onClick={() => setPage('knowledge-base')}>
              <FolderSvg fill="var(--nav-item-color)" />
              <span>{t('知识库')}</span>
            </button>
          </nav>
        </div>
        <div className="settings-content">
          {page === 'general' && <GeneralSettings />}
          {page === 'agent' && <AgentSettings />}
          {page === 'provider' && <ProviderSettings />}
          {page === 'security' && <SecuritySettings />}
          {page === 'skill' && <SkillSettings />}
          {page === 'quickinput' && <QuickInputSettings />}
          {page === 'search-engine' && <SearchEngineSettings />}
          {page === 'knowledge-base' && <KnowledgeBaseSettings />}
        </div>
      </div>
    </div>
  )
}
