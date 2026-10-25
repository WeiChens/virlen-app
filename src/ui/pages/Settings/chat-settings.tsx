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
        title: t('调用 AI 把历史总结成一段，最省 token，但需要一次模型调用（慢、要花钱）'),
      },
      {
        value: 'raw',
        label: t('正文压缩'),
        title: t('本地压缩，毫秒级完成且不花钱；正文一字不删，只去掉思考过程并省略超长工具输出'),
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
        title: t('体积最小，适合照片与截图；不支持透明（透明区会变白）'),
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
      showToast(t('文件夹选择器不可用'), 1500)
    }
  }

  return (
    <div className="chat-settings">
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
            <span className="label-text">{t('图片发送格式')}</span>
            <span className="label-desc">
              {t(
                '添加图片时按该格式处理一次（库里存的也是这份，原文件不入库）；只在过长时等比缩小',
              )}
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
              {t('发图前等比缩到该上限，同时减小请求体与视觉 token')}
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
                '点击 token 环压缩上下文时使用的方式',
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
            <span className="label-text">{t('上下文窗口')}</span>
            <span className="label-desc">
              {t(
                'token 环 / 上下文压缩百分比里「100%」对应的 token 数',
              )}
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
            <span className="label-text">{t('提问在会话内回答')}</span>
            <span className="label-desc">
              {t(
                '默认开：AI 调用 user_choice 提问时不弹窗打断，而是显示在所属会话的消息列表下方；切到那个会话才能回答\n关掉则回到跨会话弹窗（立即引导你解决）',
              )}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('提问在会话内回答')}
                checked={s.userChoiceInline}
                onChange={(e) => update('userChoiceInline', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('权限授权在会话内回答')}</span>
            <span className="label-desc">
              {t(
                '默认关：命中权限审批时立即弹窗确认；打开后与提问一样显示在会话消息列表下方，打开那个会话才能处理',
              )}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('权限授权在会话内回答')}
                checked={s.authorizationInline}
                onChange={(e) => update('authorizationInline', e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
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
    </div>
  )
}

export default observer(ChatSettings)
