/**
 * security-settings — 安全设置页面
 * 管理白名单/黑名单/忽略遍历文件夹
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  securityStore,
} from '@/ui/store/securityStore'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import AddSvg from '@/ui/components/icons/AddSvg'
import './general-settings.scss'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'

type ListType = 'whitelist' | 'blacklist' | 'skipEachDirs'

function SecuritySettings() {
  const [inputDir, setInputDir] = useState('')
  const [activeList, setActiveList] = useState<ListType>('whitelist')

  async function handleAdd() {
    let dir = inputDir.trim()
    if (!dir) {
      if (activeList === 'skipEachDirs') {
        showToast(t('请输入文件夹名（如 node_modules）'))
        return
      }
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ directory: true, multiple: false })
        if (!selected) return
        dir = selected.replace(/\\/g, '/')
      } catch {
        return
      }
    }
    if (activeList === 'skipEachDirs') {
      securityStore.addSkipEachDir(dir)
    } else {
      // 验证路径是否是一个有效目录
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke<boolean>('check_is_directory', { path: dir })
      } catch (e: any) {
        showToast(e?.message || String(e))
        return
      }
      if (activeList === 'whitelist') {
        securityStore.addToWhitelist(dir)
      } else {
        securityStore.addToBlacklist(dir)
      }
    }
    setInputDir('')
  }

  function handleRemove(dir: string, list: ListType) {
    if (list === 'skipEachDirs') {
      securityStore.removeSkipEachDir(dir)
    } else {
      securityStore.removeFromList(dir, list)
    }
  }

  const { whitelist, blacklist, skipEachDirs } = securityStore.value
  const currentList =
    activeList === 'whitelist'
      ? whitelist
      : activeList === 'blacklist'
        ? blacklist
        : skipEachDirs

  return (
    <div
      className="general-settings"
      style={{
        overflow: 'hidden',
        height: '100%',
      }}>
      <h2 className="section-title">{t('安全设置')}</h2>

      <div className="section">
        <div className="section-desc">
          <span className="t">
            {t('AI 对文件系统的访问规则如下(终端执行不在管控范围内)：')}
          </span>
          <b>{t('黑名单目录')}</b>
          {t('完全不能访问')}，<b>{t('工作目录')}</b>
          {t('可以读取和编辑文件')}，<b>{t('白名单目录')}</b>
          {t('可以读取和编辑文件')}，<b>{t('其他目录')}</b>
          {t('只能查看、不能动里面的文件')}
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('名单切换')}</span>
          </div>
          <div className="setting-control">
            <div className="segmented-control">
              <button
                className={`segment ${activeList === 'whitelist' ? 'active' : ''}`}
                onClick={() => setActiveList('whitelist')}>
                {t('白名单')}
              </button>
              <button
                className={`segment ${activeList === 'blacklist' ? 'active' : ''}`}
                onClick={() => setActiveList('blacklist')}>
                {t('黑名单')}
              </button>
              <button
                className={`segment ${activeList === 'skipEachDirs' ? 'active' : ''}`}
                onClick={() => setActiveList('skipEachDirs')}>
                {t('忽略遍历文件夹')}
              </button>
            </div>
          </div>
        </div>

        <div
          className="setting-row"
          style={{
            flexDirection: 'column',
            alignItems: 'flex-start',
          }}>
          <div className="setting-label">
            <span className="label-text">{t('添加目录')}</span>
            <span className="label-desc">
              {activeList === 'skipEachDirs'
                ? t('输入文件夹名（仅名称，非路径），如 node_modules')
                : t('输入绝对路径，如 C:/code/my-project')}
            </span>
          </div>
          <div
            className="setting-control"
            style={{
              width: '100%',
            }}>
            <div className="add-dir-input">
              <input
                type="text"
                value={inputDir}
                onChange={(e) => setInputDir(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder={
                  activeList === 'skipEachDirs'
                    ? t('输入文件夹名...')
                    : t('输入目录路径...')
                }
                autoComplete="off"
              />
              <button className="add-btn" onClick={handleAdd}>
                <AddSvg fill="#fff" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        className="section"
        style={{
          flex: 1,
          marginBottom: 2,
        }}>
        <h2 className="section-title">
          {activeList === 'whitelist'
            ? `${t('白名单')} (${whitelist.length})`
            : activeList === 'blacklist'
              ? `${t('黑名单')} (${blacklist.length})`
              : `${t('忽略遍历文件夹')} (${skipEachDirs.length})`}
        </h2>

        {currentList.length === 0 ? (
          <div className="empty-hint">
            {t('暂无')}
            {activeList === 'whitelist'
              ? t('白名单')
              : activeList === 'blacklist'
                ? t('黑名单')
                : t('忽略遍历文件夹')}
            {activeList === 'skipEachDirs'
              ? t('，请在上方添加')
              : t('目录，请在上方添加')}
          </div>
        ) : (
          <div className="dir-list">
            {currentList.map((dir) => (
              <div key={dir} className="dir-item">
                <span className="dir-path">{dir}</span>
                <button
                  className="dir-remove-btn"
                  onClick={() => handleRemove(dir, activeList)}
                  title={t('移除')}>
                  <DeleteSvg />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default observer(SecuritySettings)
