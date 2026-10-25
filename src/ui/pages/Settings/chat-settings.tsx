/**
 * chat-settings — 聊天设置页面
 *
 * 从原「通用设置」页里**拆出来**的独立菜单：聊天相关条目已经很多，混在通用设置里越来越挤。
 * 原「会话管理」分组只剩「侧边栏分组」一项，已并入本页（会话管理分组随之取消）。
 *
 * 样式复用 `general-settings.scss`（其顶层选择器为 `.general-settings, .chat-settings`）。
 */
import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState, resolveDefaultWorkspace } from '@/ui/store'
import type { SettingsStore } from '@/ui/store'
import { showToast } from '@/ui/components/shared/Toast'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import Select from '@/ui/components/shared/Select'
import { t } from '@/ui/i18n'
import './general-settings.scss'

function formatMaxTokens(v: number): string {
  return v >= 1024 ? (v / 1024).toFixed(0) + 'K' : String(v)
}

function ChatSettings() {
  const s = settingsState.value
  const [resolvedWorkspace, setResolvedWorkspace] = useState('')
  /** 上下文窗口的本地草稿（k 为单位）—— onChange 不设限，blur / 回车时才校正提交 */
  const [windowKInput, setWindowKInput] = useState(() =>
    String(s.contextWindowTokens / 1000),
  )

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

  const COMPRESS_MODE_OPTIONS: {
    value: SettingsStore['contextCompressMode']
    label: string
    title: string
  }[] = [
      {
        value: 'ai',
        label: t('AI 摘要'),
        title: t('让 AI 将历史对话总结为一段，最省 token，但需额外调用一次模型（较慢、计费）'),
      },
      {
        value: 'raw',
        label: t('正文压缩'),
        title: t('本地处理，不产生费用；仅去除思考过程并省略超长工具输出'),
      },
    ]

  /** 发图前的格式选项：三者体积/兼容性互有取舍，title 给出“什么时候该选它” */
  const IMAGE_FORMAT_OPTIONS: {
    value: SettingsStore['imageConvertFormat']
    label: string
    title: string
  }[] = [
      {
        value: 'jpeg',
        label: 'JPEG',
        title: t('体积最小，适合照片与截图；不支持透明（透明区域会变白）'),
      },
      {
        value: 'png',
        label: 'PNG',
        title: t('无损、支持透明，但体积最大（截图文字的保真度最好）'),
      },
      {
        value: 'webp',
        label: 'WebP',
        title: t('同画质下比 JPEG 再小一截，支持透明；个别接口可能不认'),
      },
    ]

  /** 最长边选项：同时影响请求体字节与视觉 token */
  const IMAGE_MAX_DIMENSION_OPTIONS: { value: number; label: string; title: string }[] = [
    { value: 1024, label: '1024', title: t('最省 token，细节损失明显') },
    { value: 1568, label: '1568', title: t('推荐：常见视觉模型的分档上限') },
    { value: 2048, label: '2048', title: t('保留更多细节，体积与 token 更大') },
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

  // 设置值被外部改变（水合 / 其它入口）时同步草稿，避免显示与真值不一致
  useEffect(() => {
    setWindowKInput(String(s.contextWindowTokens / 1000))
  }, [s.contextWindowTokens])

  /** 提交上下文窗口（k）：blur / 回车时校正；非法则回退到当前设置值 */
  function commitContextWindow() {
    const k = Number(windowKInput)
    if (Number.isFinite(k) && k > 0) {
      const tokens = Math.round(k * 1000)
      update('contextWindowTokens', tokens)
      setWindowKInput(String(tokens / 1000))
    } else {
      setWindowKInput(String(s.contextWindowTokens / 1000))
    }
  }

  async function pickFolder() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false })
      if (selected) {
        update('defaultWorkspace', selected.replace(/\\/g, '/'))
      }
    } catch {
      showToast(t('无法打开文件夹选择器'), 1500)
    }
  }

  return (
    <div className="chat-settings">
      <h2 className="section-title">{t('聊天设置')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('单次回复长度')}</span>
            <span className="label-desc">
              {t('单次回复的最大长度')}（{t('当前')}:{' '}
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
            <span className="label-desc">{t('新建对话的默认工作目录')}</span>
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
                title={t('选择文件夹')}>
                <FolderSvg fill="var(--text-secondary)" />
              </button>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('图片内容提取（本地）')}</span>
            <span className="label-desc">
              {t('在本地提取图片中的文字与界面元素后发送给模型，比直接发送图片更省 token')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('图片内容提取（本地）')}
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
            <span className="label-text">{t('图片发送格式')}</span>
            <span className="label-desc">
              {t('图片按该格式存储；超出尺寸时等比缩小')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.imageConvertFormat}
              onChange={(v) => update('imageConvertFormat', v)}
              options={IMAGE_FORMAT_OPTIONS}
              width={120}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('图片最长边')}</span>
            <span className="label-desc">
              {t('发送前将长边缩至该尺寸以内，以减小请求体积与 token 消耗')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.imageMaxDimension}
              onChange={(v) => update('imageMaxDimension', v)}
              options={IMAGE_MAX_DIMENSION_OPTIONS}
              width={120}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('图片预览自动识别文字')}</span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('图片预览自动识别文字')}
                checked={s.imageOcrAutoPreview}
                onChange={(e) =>
                  update('imageOcrAutoPreview', e.target.checked)
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
              {t('根据对话内容自动生成标题；关闭后用首条消息代替')}
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
              {t('点击 token 环压缩上下文时采用的方式')}
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
            <span className="label-text">{t('上下文窗口')}</span>
            <span className="label-desc">
              {t('token 环显示 100% 时对应的 token 数')}
            </span>
          </div>
          <div className="setting-control">
            <div className="unit-input">
              <input
                type="number"
                min="1"
                step="1"
                aria-label={t('上下文窗口')}
                value={windowKInput}
                onChange={(e) => setWindowKInput(e.target.value)}
                onBlur={commitContextWindow}
                onKeyDown={(e) => {
                  // 回车在 number 输入框里不提交表单 —— 主动失焦即触发校正
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur()
                  }
                }}
              />
              <span className="unit">k</span>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('提问在对话内回答')}</span>
            <span className="label-desc">
              {t('开启后，提问显示在所属对话下方，进入该对话时作答；关闭则弹窗提醒')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('提问在对话内回答')}
                checked={s.userChoiceInline}
                onChange={(e) => update('userChoiceInline', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('授权请求在对话内处理')}</span>
            <span className="label-desc">
              {t('开启后，授权请求显示在所属对话下方，进入该对话时处理')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('授权请求在对话内处理')}
                checked={s.authorizationInline}
                onChange={(e) => update('authorizationInline', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('自动切换到前台')}</span>
            <span className="label-desc">
              {t('AI 回复完成或需要选择时，若窗口未激活则自动置前')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('自动切换到前台')}
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
              {t('点关闭仅隐藏窗口，AI 继续在后台运行；从托盘菜单可退出')}
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
              {t('窗口未显示或未激活时提醒你')}
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
              {t('启动时预加载技能描述，响应更快，但会提前消耗 token')}
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
              {t('单次对话中连续调用工具的最大轮数')}
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
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('侧边栏分组')}</span>
            <span className="label-desc">{t('对话列表的分组方式')}</span>
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
    </div>
  )
}

export default observer(ChatSettings)
