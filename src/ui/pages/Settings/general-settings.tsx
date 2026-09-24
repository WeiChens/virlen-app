/**
 * general-settings — 通用设置页面
 * 从 settingsState 读取/写入
 */
import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState, resolveDefaultWorkspace } from '@/ui/store'
import type { SettingsStore, SandboxMode } from '@/ui/store'
import { showToast } from '@/ui/components/shared/Toast'
import {
  telemetryState,
  recordTelemetryToggle,
  exportTelemetryBundle,
  clearTelemetry,
  isTelemetryBuildDisabled,
} from '@/utils/telemetry'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import Select from '@/ui/components/shared/Select'
import { t, tpl } from '@/ui/i18n'
import './general-settings.scss'
import { openUrl } from '@tauri-apps/plugin-opener'

function formatMaxTokens(v: number): string {
  return v >= 1024 ? (v / 1024).toFixed(0) + 'K' : String(v)
}

function GeneralSettings() {
  const s = settingsState.value
  const [resolvedWorkspace, setResolvedWorkspace] = useState('')
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

  const MAX_ITERATIONS_OPTIONS: { value: number; label: string }[] = [
    { value: 1, label: t('1 次') },
    { value: 3, label: t('3 次') },
    { value: 5, label: t('5 次') },
    { value: 8, label: t('8 次') },
    { value: 10, label: t('10 次') },
  ]

  const SESSION_GROUP_OPTIONS: {
    value: 'agent' | 'workspace'
    label: string
  }[] = [
      { value: 'agent', label: t('按 Agent') },
      { value: 'workspace', label: t('按工作目录') },
    ]

  const SANDBOX_MODE_OPTIONS: { value: SandboxMode; label: string, title: string }[] = [
    { value: 'on', label: t('默认模式'), title: t('默认模式，有读文件的权限，只能在工作目录里有写的权限') },
    { value: 'readonly', label: t('只读模式'), title: t('只读模式，只有读文件的权限，无法写入文件') },
    { value: 'off', label: t('完全访问模式'), title: t('完全访问模式，可以访问系统文件，有风险，请谨慎使用') },
  ]

  const COMPRESS_MODE_OPTIONS: {
    value: SettingsStore['contextCompressMode']
    label: string
    title: string
  }[] = [
    {
      value: 'ai',
      label: t('AI 摘要'),
      title: t('调用 AI 把历史总结成一段，最省 token，但需要一次模型调用（慢、要花钱）'),
    },
    {
      value: 'raw',
      label: t('正文压缩'),
      title: t('本地压缩，毫秒级完成且不花钱；正文一字不删，只去掉思考过程并省略超长工具输出'),
    },
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
                '发送的图片会进行 UI 检测 + OCR + 物体检测\n提取结构化文本发给 AI，而非发送原始图片\n让LLM拥有视觉能力\n让VLM更节省token，但是伪视觉分析，没有真实VLM分析的智能',
              )}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('本地图片伪视觉分析')}
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
                aria-label={t('隐藏思考过程')}
                checked={s.hideToolCallThink}
                onChange={(e) => update('hideToolCallThink', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('AI 生成标题')}</span>
            <span className="label-desc">
              {t(
                '用 AI 根据对话内容生成会话标题\n关闭后不再发起标题生成的 LLM 调用，直接截取首条用户消息',
              )}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('AI 生成标题')}
                checked={s.aiGenerateTitle}
                onChange={(e) => update('aiGenerateTitle', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('上下文压缩方式')}</span>
            <span className="label-desc">
              {t(
                '点击 token 环压缩上下文时使用的方式\nAI 摘要更省 token，但需要一次模型调用；正文压缩本地完成、毫秒级，正文不删，只去掉思考过程并省略超长工具输出',
              )}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.contextCompressMode}
              onChange={(v) =>
                update(
                  'contextCompressMode',
                  v as SettingsStore['contextCompressMode'],
                )
              }
              options={COMPRESS_MODE_OPTIONS}
              width={160}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('强制激活窗口')}</span>
            <span className="label-desc">
              {t(
                'AI 回复完成或需要用户选择时，若窗口未激活则自动将窗口置为活动状态\n窗口还在时不再额外推送系统通知；窗口已关闭（托盘还在）时仍会推送',
              )}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('强制激活窗口')}
                checked={s.forceWindowActive}
                onChange={(e) =>
                  update('forceWindowActive', e.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('关闭窗口时隐藏到托盘')}</span>
            <span className="label-desc">
              {t('点关闭按钮只隐藏窗口，AI 继续在后台工作；从托盘菜单可真正退出')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('关闭窗口时隐藏到托盘')}
                checked={s.closeToTray}
                onChange={(e) => update('closeToTray', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('回复完成时提醒我')}</span>
            <span className="label-desc">
              {t('窗口未显示或未激活时，用任务栏闪烁 + 托盘提示提醒（含未读计数）')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('回复完成时提醒我')}
                checked={s.notifyOnComplete}
                onChange={(e) => update('notifyOnComplete', e.target.checked)}
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
                aria-label={t('预加载技能元数据')}
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
        {/* <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('最大迭代次数')}</span>
            <span className="label-desc">
              {t('迭代验证模式（执行→验证→修复）中 AI 自动重试的最大次数')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.maxIterations}
              onChange={(v) => update('maxIterations', v)}
              options={MAX_ITERATIONS_OPTIONS}
              width={120}
            />
          </div>
        </div> */}
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
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('Rust 原生引擎')}</span>
            <span className="label-desc">
              {t(
                '使用 Rust 实现底层agent循环',
              )}  
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('Rust 原生引擎')}
                checked={s.useRustEngine}
                onChange={(e) => update('useRustEngine', e.target.checked)}
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
