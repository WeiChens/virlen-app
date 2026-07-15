/**
 * general-settings — 通用设置页面
 * 从 settingsState 读取/写入
 */
import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState, resolveDefaultWorkspace } from '@/ui/store'
import type { SettingsStore, CommandApprovalMode } from '@/ui/store'
import { showToast } from '@/ui/components/shared/Toast'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import Select from '@/ui/components/shared/Select'
import { t } from '@/ui/i18n'
import './general-settings.scss'

function formatMaxTokens(v: number): string {
  return v >= 1024 ? (v / 1024).toFixed(0) + 'K' : String(v)
}

function GeneralSettings() {
  const s = settingsState.value
  const [resolvedWorkspace, setResolvedWorkspace] = useState('')

  const LANGUAGE_OPTIONS: {
    value: SettingsStore['language']
    label: string
  }[] = [
    { value: 'zh-CN', label: t('简体中文') },
    { value: 'en-US', label: t('English') },
  ]

  const THEME_OPTIONS: { value: SettingsStore['theme']; label: string }[] = [
    { value: 'system', label: t('跟随系统') },
    { value: 'light', label: t('浅色') },
    { value: 'dark', label: t('深色') },
  ]

  const FONT_SIZE_OPTIONS: {
    value: SettingsStore['fontSize']
    label: string
  }[] = [
    { value: 'small', label: t('小') },
    { value: 'medium', label: t('中') },
    { value: 'large', label: t('大') },
  ]

  const MAX_TOKENS_OPTIONS: { value: number; label: string }[] = [
    { value: 8192, label: '8K' },
    { value: 32768, label: '32K' },
    { value: 131072, label: '128K' },
    { value: 262144, label: '256K' },
  ]

  const MAX_TOOL_ROUNDS_OPTIONS: { value: number; label: string }[] = [
    { value: 10, label: t('10 轮') },
    { value: 20, label: t('20 轮') },
    { value: 30, label: t('30 轮') },
    { value: 50, label: t('50 轮') },
    { value: 100, label: t('100 轮') },
    { value: 99999999, label: t('无限') },
  ]

  const SESSION_GROUP_OPTIONS: {
    value: 'agent' | 'workspace'
    label: string
  }[] = [
    { value: 'agent', label: t('按 Agent') },
    { value: 'workspace', label: t('按工作目录') },
  ]

  const APPROVAL_MODE_OPTIONS: { value: CommandApprovalMode; label: string }[] =
    [
      { value: 'all', label: t('全部弹窗') },
      { value: 'risky', label: t('仅高危弹窗') },
      { value: 'install', label: t('安装+高危弹窗') },
      { value: 'none', label: t('关闭（不弹窗）') },
    ]

  useEffect(() => {
    if (!s.defaultWorkspace) {
      resolveDefaultWorkspace().then(setResolvedWorkspace)
    }
  }, [s.defaultWorkspace])

  function update<K extends keyof SettingsStore>(
    key: K,
    value: SettingsStore[K],
  ) {
    settingsState.setValue(key, value)
  }

  async function pickFolder() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false })
      if (selected) {
        update('defaultWorkspace', selected.replace(/\\/g, '/'))
      }
    } catch {
      showToast(t('文件夹选择器不可用'), 1500)
    }
  }

  return (
    <div className="general-settings">
      <h2 className="section-title">{t('通用设置')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('语言')}</span>
            <span className="label-desc">{t('界面显示语言')}</span>
          </div>
          <div className="setting-control">
            <div className="segmented-control">
              {LANGUAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`segment ${s.language === opt.value ? 'active' : ''}`}
                  onClick={() => update('language', opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('主题')}</span>
            <span className="label-desc">{t('应用外观配色')}</span>
          </div>
          <div className="setting-control">
            <div className="segmented-control">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`segment ${s.theme === opt.value ? 'active' : ''}`}
                  onClick={() => update('theme', opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('字体大小')}</span>
            <span className="label-desc">{t('聊天消息字体大小')}</span>
          </div>
          <div className="setting-control">
            <div className="segmented-control">
              {FONT_SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`segment ${s.fontSize === opt.value ? 'active' : ''}`}
                  onClick={() => update('fontSize', opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <h2 className="section-title">{t('会话管理')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('侧边栏分组')}</span>
            <span className="label-desc">{t('会话列表的分组方式')}</span>
          </div>
          <div className="setting-control">
            <div className="segmented-control">
              {SESSION_GROUP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`segment ${s.sessionGroupType === opt.value ? 'active' : ''}`}
                  onClick={() => update('sessionGroupType', opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <h2 className="section-title">{t('聊天设置')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('最大输出 Token')}</span>
            <span className="label-desc">
              {t('单次回复的最大 token 数')}（{t('当前')}:{' '}
              {formatMaxTokens(s.maxTokens)}）
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.maxTokens}
              onChange={(v) => update('maxTokens', v)}
              options={MAX_TOKENS_OPTIONS}
              width={120}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('默认工作目录')}</span>
            <span className="label-desc">{t('新会话的默认工作目录')}</span>
          </div>
          <div className="setting-control">
            <div className="input-with-btn">
              <input
                type="text"
                className="text-input"
                value={s.defaultWorkspace}
                onChange={(e) => update('defaultWorkspace', e.target.value)}
                placeholder={resolvedWorkspace || t('未设置')}
                autoComplete="off"
              />
              <button
                className="folder-btn"
                onClick={pickFolder}
                title={t('选择目录')}>
                <FolderSvg fill="var(--text-secondary)" />
              </button>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('本地图片伪视觉分析')}</span>
            <span className="label-desc">
              {t(
                '发送的图片会进行 UI 检测 + OCR + 物体检测\n提取结构化文本发给 AI，而非发送原始图片\n让VLM拥有视觉能力\n让VLM更节省token，但是伪视觉分析，没有真实VLM分析的智能',
              )}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                checked={s.imageVisionAnalyzeOptimize}
                onChange={(e) =>
                  update('imageVisionAnalyzeOptimize', e.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('隐藏思考过程')}</span>
            <span className="label-desc">
              {t('隐藏工具调用的思考过程消息，让对话更简洁')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                checked={s.hideToolCallThink}
                onChange={(e) => update('hideToolCallThink', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('预加载技能元数据')}</span>
            <span className="label-desc">
              {t('启动时预先拉取 skill 的描述信息，但会提前消耗 TOKEN')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                checked={s.skillMetaPreload}
                onChange={(e) => update('skillMetaPreload', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('最大工具调用轮数')}</span>
            <span className="label-desc">
              {t('单次对话中 LLM 可连续调用工具的最大次数')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.maxToolRounds}
              onChange={(v) => update('maxToolRounds', v)}
              options={MAX_TOOL_ROUNDS_OPTIONS}
              width={120}
            />
          </div>
        </div>
      </div>
      <h2 className="section-title">{t('安全设置')}</h2>

      <div className="section">
        <div
          className="setting-row"
          style={{
            borderBottom: 'none',
          }}>
          <div className="setting-label">
            <span className="label-text">{t('命令执行授权')}</span>
            <span className="label-desc">
              {t('设定终端命令执行前是否需要弹窗确认')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.commandApprovalMode}
              onChange={(v) =>
                update('commandApprovalMode', v as CommandApprovalMode)
              }
              options={APPROVAL_MODE_OPTIONS}
              width={160}
            />
          </div>
        </div>
        <div className="approval-desc">
          {s.commandApprovalMode === 'all' && t('所有命令执行前都会弹窗确认')}
          {s.commandApprovalMode === 'risky' &&
            t(
              '仅高危命令（删除/修改系统等）执行前弹窗确认，安装类命令直接执行',
            )}
          {s.commandApprovalMode === 'install' &&
            t('高危命令和安装类命令执行前弹窗确认，安全命令直接执行')}
          {s.commandApprovalMode === 'none' &&
            t('所有命令直接执行，不再弹窗确认')}
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('注入环境信息')}</span>
            <span className="label-desc">
              {t('在系统提示词中自动加入当前 OS、工作目录、工具版本等信息')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                checked={s.allowEnvPrompt}
                onChange={(e) => update('allowEnvPrompt', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

export default observer(GeneralSettings)
