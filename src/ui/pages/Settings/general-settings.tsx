/**
 * general-settings — 通用设置页面
 * 从 settingsState 读取/写入
 *
 * 聊天相关条目已拆到独立菜单 `chat-settings`（含原「会话管理」的「侧边栏分组」）。
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import type { SettingsStore, SandboxMode } from '@/ui/store'
import { showToast } from '@/ui/components/shared/Toast'
import {
  telemetryState,
  recordTelemetryToggle,
  exportTelemetryBundle,
  clearTelemetry,
  isTelemetryBuildDisabled,
} from '@/utils/telemetry'
import Select from '@/ui/components/shared/Select'
import { t, tpl } from '@/ui/i18n'
import './general-settings.scss'
import { openUrl } from '@tauri-apps/plugin-opener'

function GeneralSettings() {
  const s = settingsState.value
  const [telemetryBusy, setTelemetryBusy] = useState(false)

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

  const SANDBOX_MODE_OPTIONS: { value: SandboxMode; label: string, title: string }[] = [
    { value: 'on', label: t('默认模式'), title: t('默认模式，有读文件的权限，只能在工作目录里有写的权限') },
    { value: 'readonly', label: t('只读模式'), title: t('只读模式，只有读文件的权限，无法写入文件') },
    { value: 'off', label: t('完全访问模式'), title: t('完全访问模式，可以访问系统文件，有风险，请谨慎使用') },
  ]

  function update<K extends keyof SettingsStore>(
    key: K,
    value: SettingsStore[K],
  ) {
    settingsState.setValue(key, value)
  }

  // ==================== 诊断埋点（§8） ====================
  const telemetryBuildDisabled = isTelemetryBuildDisabled()

  function toggleTelemetry(enabled: boolean) {
    settingsState.setValue('telemetryEnabled', enabled)
    // telemetry.toggle 无论开关状态都记录（§12.15）
    recordTelemetryToggle(enabled)
    if (!enabled) {
      // §7.1.3 隐私红线：关闭即停止采集并清空本地已采集数据（禁用为破坏性操作）
      const n = clearTelemetry()
      if (n > 0) {
        showToast(tpl('已清理 $__n__ 条埋点数据', { n }), 1800)
      }
    }
  }

  async function handleExportTelemetry() {
    if (telemetryBusy) return
    setTelemetryBusy(true)
    try {
      const r = await exportTelemetryBundle()
      if (r) {
        showToast(tpl('已导出 $__n__ 条到本地', { n: r.count }), 2000)
      }
    } catch (e: any) {
      showToast(t('导出失败') + t('：') + (e?.message || String(e)), 2500)
    } finally {
      setTelemetryBusy(false)
    }
  }

  async function handlePreviewTelemetry() {
    try {
      await openUrl('https://virlen.cn/trace/')
    } catch (e: any) {
      showToast(
        t('打开可视化预览失败') + '：' + (e?.message || String(e)),
        2500,
      )
    }
  }

  function handleClearTelemetry() {
    if (telemetryState.bufferedCount === 0) {
      showToast(t('暂无埋点数据'), 1500)
      return
    }
    const n = clearTelemetry()
    showToast(tpl('已清理 $__n__ 条埋点数据', { n }), 1800)
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
            {/* data-font-size 挂在 <html> 上，实际影响整个界面（侧栏/设置/快捷输入）与聊天消息，
                原描述「聊天消息字体大小」与行为不符 */}
            <span className="label-desc">{t('界面与聊天消息字体大小')}</span>
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
      <h2 className="section-title">{t('命令与终端安全')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('终端权限')}</span>
            <span className="label-desc">
              {t('对终端命令权限的设定')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.sandboxMode}
              onChange={(v) => update('sandboxMode', v as SandboxMode)}
              options={SANDBOX_MODE_OPTIONS}
              width={160}
            />
          </div>
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
                aria-label={t('注入环境信息')}
                checked={s.allowEnvPrompt}
                onChange={(e) => update('allowEnvPrompt', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>
      <h2 className="section-title">{t('诊断埋点')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('诊断埋点')}</span>
            <span className="label-desc">
              {t(
                '开启后在本地记录运行数据，用于排查问题。\n关闭时停止采集；数据仅保存在本地，不会自动外发',
              )}
              {telemetryBuildDisabled && (
                <span className="telemetry-build-off">
                  {t('（当前构建已禁用埋点）')}
                </span>
              )}
            </span>
          </div>
          <div className="setting-control">
            <div className="telemetry-toggle-wrap">
              <label className="toggle">
                <input
                  type="checkbox"
                  aria-label={t('诊断埋点')}
                  checked={s.telemetryEnabled}
                  disabled={telemetryBuildDisabled}
                  onChange={(e) => toggleTelemetry(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
              <span className="telemetry-count">
                ● {telemetryState.bufferedCount} {t('条')}
              </span>
            </div>
          </div>
        </div>
        <div className="telemetry-actions">
          <button
            className="tel-btn"
            onClick={handleExportTelemetry}
            disabled={telemetryBusy || telemetryState.bufferedCount === 0}>
            {t('导出本地')}
          </button>
          <button
            className="tel-btn primary"
            onClick={handlePreviewTelemetry}>
            {t('可视化预览')}
          </button>
          <button
            className="tel-btn danger"
            onClick={handleClearTelemetry}
            disabled={telemetryBusy || telemetryState.bufferedCount === 0}>
            {t('清理数据')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default observer(GeneralSettings)
