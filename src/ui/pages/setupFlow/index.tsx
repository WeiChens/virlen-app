/**
 * SetupFlow — 首次启动引导流程
 *
 * 分三步：
 *   1. Welcome — 展示应用介绍，引导用户开始配置
 *   2. Set Workdir — 设置默认工作目录
 *   3. Model Setup — 选择模型服务商 + 填写 API Key
 *
 * 配置完成后自动切换到 ChatView。
 */
import { useState, useRef, useEffect } from 'react'
import { t, tpl } from '@/ui/i18n'
import { AppLogoSvg, appName } from '@/ui/constants'
import { settingsState, resolveDefaultWorkspace } from '@/ui/store/settingStore'
import type { ProviderType } from '@/types'
import { getProviderIcon } from '@/ui/pages/Settings/provider-icons'
import { showToast } from '@/ui/components/shared/Toast'
import './style.scss'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import { providerService } from '@/services/provider-service'
import { createProviderInstance } from '@/infrastructure/provider'
import { providerPort } from '@/domain'
import { uuid } from '@/utils/uuid'

interface Props {
  onComplete: () => void
}

/* ==================== 自定义下拉框 ==================== */

const defaultProviderList = providerService.getDefaultProviderList()
function ProviderSelect({
  value,
  onChange,
}: {
  value: string | null
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const options = defaultProviderList
  const selected = options.find((opt) => opt.templateName === value)

  return (
    <div className="provider-select" ref={ref}>
      <button
        className="provider-select-trigger"
        onClick={() => setOpen(!open)}
        type="button">
        {selected ? (
          <>
            <span className="provider-select-icon">
              {getProviderIcon(selected.templateName)}
            </span>
            <span className="provider-select-label">{t(selected.label)}</span>
          </>
        ) : (
          <span className="provider-select-placeholder">
            {t('请选择模型服务商')}
          </span>
        )}
        <span className={`provider-select-arrow${open ? ' open' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="provider-select-dropdown">
          {options.map((opt) => (
            <button
              key={opt.templateName}
              className={`provider-select-item${value === opt.templateName ? ' active' : ''}`}
              onClick={() => {
                onChange(opt.templateName)
                setOpen(false)
              }}
              type="button">
              <span className="provider-select-icon">
                {getProviderIcon(opt.templateName)}
              </span>
              <span className="provider-select-label">{t(opt.label)}</span>
              <span className="provider-select-url">{opt.baseUrl}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ==================== 第二步：设置工作目录 ==================== */

function SetupWorkdirPage({ onNext }: { onNext: () => void }) {
  const [workdir, setWorkdir] = useState(settingsState.value.defaultWorkspace)
  const [loading, setLoading] = useState(false)

  // 首次挂载时尝试解析默认目录
  useEffect(() => {
    if (!workdir) {
      resolveDefaultWorkspace().then((dir) => {
        if (dir) setWorkdir(dir)
      })
    }
  }, [])

  async function handleSelect() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: workdir || undefined,
      })
      if (selected) {
        setWorkdir(selected.replace(/\\/g, '/'))
      }
    } catch {
      // 非 Tauri 环境忽略
    }
  }

  async function handleConfirm() {
    setLoading(true)
    settingsState.setValue('defaultWorkspace', workdir || '')
    // 等待存储持久化
    await new Promise((r) => setTimeout(r, 100))
    setLoading(false)
    onNext()
  }

  return (
    <div className="setup-workdir">
      <h2>{t('默认工作目录')}</h2>
      <p className="setup-desc">
        {t(
          '选择一个文件夹作为默认工作目录，AI 将在该目录下读写文件、执行命令。',
        )}
      </p>

      <div className="workdir-display">
        <div className="workdir-path">
          <span className="workdir-path-icon">
            <FolderSvg />
          </span>
          <span className="workdir-path-text">
            {workdir || t('尚未选择目录')}
          </span>
        </div>
      </div>

      <button className="btn-secondary" onClick={handleSelect} type="button">
        {t('选择文件夹')}
      </button>

      <p className="workdir-hint">
        {t('你也可以跳过此步骤，之后在设置中随时修改。')}
      </p>

      <div className="setup-actions">
        <button className="btn-ghost" onClick={() => onNext()} type="button">
          {t('跳过')}
        </button>
        <button
          className="btn-primary"
          disabled={loading}
          onClick={handleConfirm}
          type="button">
          {loading ? (
            <span className="btn-loading">
              <span className="btn-spinner" />
              {t('保存中...')}
            </span>
          ) : (
            t('确认，下一步')
          )}
        </button>
      </div>
    </div>
  )
}

/* ==================== 第三步：模型配置 ==================== */

function SetupProviderPage({
  onBack,
  onComplete,
}: {
  onBack?: () => void
  onComplete: () => void
}) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)

  const template = selectedTemplate
    ? defaultProviderList.find((opt) => opt.templateName === selectedTemplate)
    : null
  const isCustom = selectedTemplate === 'custom'

  /** 自动获取模型列表，成功后自动填入第一个模型 ID */
  async function handleFetchModels() {
    if (!template || !apiKey.trim()) return
    if (isCustom && !customBaseUrl.trim()) return
    setFetching(true)

    try {
      const resolvedBaseUrl = isCustom ? customBaseUrl.trim() : template.baseUrl

      const providerConfig = {
        id: uuid(),
        name: isCustom
          ? tpl('自定义 ($__host__)', {
              host: new URL(resolvedBaseUrl).hostname,
            })
          : t(template.label),
        templateName: template.templateName as any,
        type: template.type as ProviderType,
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl,
        models: [] as string[],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const instance = createProviderInstance(providerConfig)
      if (!instance) throw new Error(t('创建 Provider 实例失败'))

      const fetchedModels = await instance.listModels()
      if (!fetchedModels || fetchedModels.length === 0) {
        throw new Error(t('未获取到可用模型'))
      }

      setModelId(fetchedModels[0])
      showToast(tpl('已自动填入: $__model__', { model: fetchedModels[0] }))
    } catch (err: any) {
      showToast(
        tpl('获取失败: $__error__', { error: err.message || String(err) }),
      )
    } finally {
      setFetching(false)
    }
  }

  /** 保存配置（含 API Key 验证）并完成初始化 */
  async function handleSave() {
    if (!template || !apiKey.trim() || !modelId.trim()) return
    setSaving(true)

    try {
      const resolvedBaseUrl = isCustom ? customBaseUrl.trim() : template.baseUrl

      const providerConfig = {
        id: uuid(),
        name: isCustom
          ? tpl('自定义 ($__host__)', {
              host: new URL(resolvedBaseUrl).hostname,
            })
          : t(template.label),
        templateName: template.templateName as any,
        type: template.type as ProviderType,
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl,
        models: [modelId.trim()],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const instance = createProviderInstance(providerConfig)
      if (!instance) throw new Error(t('创建 Provider 实例失败'))

      const valid = await instance.validateApiKey(providerConfig)
      if (!valid) throw new Error(t('API Key 验证失败，请检查后重试'))

      providerPort.register(providerConfig.id, instance)

      const providers = [...settingsState.value.providers, providerConfig]
      settingsState.setValue('providers', providers)

      settingsState.setValue('defaultSelectModel', {
        providerConfigId: providerConfig.id,
        modelId: modelId.trim(),
      })

      onComplete()
    } catch (err: any) {
      showToast(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  function resetProvider() {
    setApiKey('')
    setCustomBaseUrl('')
    setModelId('')
    setFetching(false)
    setSaving(false)
  }

  return (
    <div className="setup-provider">
      <div className="setup-provider-icon">
        <svg
          viewBox="0 0 1024 1024"
          width="64"
          height="64"
          xmlns="http://www.w3.org/2000/svg">
          <path
            d="M901.2 411.3c68 46.9 77.8 152.1 21.4 208.6-6.8 6.8-9.2 5-13.7-2.2-22.6-36.6-55.1-59.1-97.8-65.9-6.9-1.1-16.6-4.7-17.9 6.4-1.2 10.1 8.3 9 14.9 9.8 52 6.6 96.8 51.8 104.7 105.6 8.6 58.9-19.5 115.4-68.9 137.9-4.1-4.1-1.5-9.3-1.5-13.8-0.5-40.2-17.8-72.5-46.5-99.5-4.5-4.2-9.8-8.4-15.2-1.9-4.8 5.7-0.4 10 3.9 13.8 68.7 61.3 50.8 161-38.9 202.5-62.6 29-144.4 15.6-190.9-31.5-21.1-21.4-32.6-46.8-32.4-77.4 0.4-43.7 0.4-87.4-0.1-131.1-0.1-10.3 2.7-12.4 12.8-10.5 34.7 6.5 60.2 31.6 68.7 67.8 1.6 6.8-1.5 20.9 11.8 17.5 10.9-2.9 5.4-14.4 3.8-21.9-9.4-44-42.4-73.8-88.5-80-6.2-0.8-8.5-2.5-8.5-8.9 0.2-46.2 0.2-92.4 0-138.6-0.1-10.1 5-6.6 10.3-5.3 38.8 9.4 73.7 2.5 103.6-24.9 2.2-2 4.3-4.2 6.2-6.4 3.7-4.2 5-8.8 0.5-13.1-5-4.8-9.1-1.7-12.7 2.2-15.7 17.4-35.4 26.8-58.4 29.5-3.4 0.4-6.9 0.6-10.4 0.5-35.2-0.8-39.3-5-39.3-39.4 0-66.1-0.7-132.1 0.2-198.2C523.9 140 630 68.9 726 105.6c60.3 23.1 87.2 83.5 88.9 134.7 0.4 13.4-6.9 8.3-13.4 6.3C735.7 227 667 251.7 630.8 308c-16.6 25.9-23.8 54.3-21.6 85 0.3 3.9 1.1 7.9 2.1 11.7 1.2 4.6 4.6 6.3 9.1 5.5 3.9-0.7 6.1-3.2 6.2-7.2 0.1-3-0.3-5.9-0.5-8.9-5-67.8 44-128.5 110.2-136.3 73.6-8.7 134.3 34.4 147 103.6 6.9 37.8-0.9 71.8-22.1 103.3-3.5 5.2-9.8 11-2.2 16.5 8.4 6.1 12.1-2.6 16-7.8 13.8-18 21.1-39 26.2-62.1zM226.6 703.1c5.1-5.1 11.1-15.4 19.3-7.3 8.9 8.8-2.9 13.7-7.8 18.5-47.7 47.7-49.6 115-4.2 164.3 60.7 66 183.9 64.7 243.2-2.6 16.2-18.4 27.5-39.4 27.6-64.3 0.5-106.8 0.2-213.6 0.6-320.3 0-11.1-4.7-11.1-12.7-8.5-22 7.2-36.4 21.4-41.7 44.3-1.5 6.4-2.7 13.9-11.9 11.2-8.1-2.4-5.9-9.4-4.3-15C443 493 462 473 493.1 466.7c9.9-2 12.4-5.8 12.4-15.5-0.4-63.1-0.6-126.2 0-189.2 0.3-35.8-10.9-67.2-32.6-95.1C433.3 116 366.4 98.3 307.3 123c-59.5 24.8-92.8 82.4-85.2 147.1 6.9 58.3 58.1 107.7 120.4 117.1 7 1.1 20.9-2.6 19 10.2-1.8 12.9-14.9 7.1-22.3 5.7-67-12.3-112-50.3-130.5-116.7-3.7-13.4-7.6-10.3-14.9-4.5-40.6 32.5-57.3 74.7-50.5 126.2 2.8 21.1 11 40 23.2 57.4 3.6 5.2 9.5 11 1.5 16.3-7.9 5.3-11.3-2.6-15-7.4-2.7-3.5-5.1-7.3-7.4-11.2-9.6-15.8-14.7-33.4-19.2-51.3-64.9 41.7-80.8 145.8-19.8 209.2 8.1 8.4 9.4-0.1 12.2-4.4 23.8-37.4 57.6-59.3 101.4-65.9 5.9-0.9 12.9-1.9 14.4 6.2 1.6 8.3-5.1 9.4-11.2 10.4-65.8 11.7-105.5 55.8-110.3 122.8-3.6 49.3 28 103.2 72.8 121.7-3.8-43.7 11.1-79.2 40.7-108.8z m429.6-34.4c-5.4 3.1-13.4 5.1-9.1 13.7 4.2 8.4 10.8 4.1 16.5 1.1 46.1-24.2 72.9-82.9 60.9-133.6-1.3-5.6-2.2-12.9-10.6-11.4-8.4 1.5-7.2 8.4-5.6 14.2 1.9 7.3 2.1 14.6 2.4 22.2-1.5 40.8-18.2 73-54.5 93.8zM324.3 671c3.9 5.2 8.4 11.7 15.6 6.4 6.7-4.9 1.6-10.3-1.8-15.2-35.8-51.2-35.8-107 0-157.7 3.4-4.9 8.8-10.1 2.1-15.3-7.1-5.5-11.7 0.6-15.7 5.9-19.3 25.9-29.4 54.8-29 85.7-0.6 34.4 9.2 63.9 28.8 90.2z"
            fill="currentColor"
          />
        </svg>
      </div>
      <h2>{t('配置模型服务')}</h2>
      <p className="setup-desc">
        {t('选择一个模型服务商并填写 API Key，即可开始对话。')}
      </p>

      {/* 服务商选择 */}
      <ProviderSelect
        value={selectedTemplate}
        onChange={(v) => {
          setSelectedTemplate(v)
          resetProvider()
        }}
      />

      {isCustom && (
        <div className="api-key-section">
          <label className="api-key-label">Base URL</label>
          <input
            className="api-key-input"
            type="url"
            placeholder="https://api.example.com/v1"
            value={customBaseUrl}
            onChange={(e) => setCustomBaseUrl(e.target.value)}
            autoFocus
            autoComplete="off"
          />
          <p className="api-key-hint">
            {t('输入兼容 OpenAI 接口的 API 地址。')}
          </p>
        </div>
      )}

      {template && (
        <div className="api-key-section">
          <label className="api-key-label">
            {tpl('API Key（$__label__）', { label: t(template.label) })}
          </label>
          <input
            className="api-key-input"
            type="password"
            placeholder={t('输入你的 API Key...')}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus={!isCustom}
            autoComplete="new-password"
          />
          <p className="api-key-hint">
            {t('API Key 仅存储在本地，不会上传。')}
          </p>
        </div>
      )}

      {template && (
        <div className="api-key-section">
          <label className="api-key-label">{t('模型 ID')}</label>
          <div className="model-input-row">
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={t('例如: deepseek-v4-flash, deepseek-v4-pro')}
              autoComplete="off"
            />
            <button
              type="button"
              className="fetch-models-btn"
              onClick={handleFetchModels}
              disabled={fetching}>
              {fetching ? t('获取中...') : t('自动获取')}
            </button>
          </div>
          <p className="api-key-hint">
            {t('输入你要使用的模型 ID。不确定时可点击「自动获取」尝试拉取。')}
          </p>
        </div>
      )}

      <div className="setup-actions">
        {onBack && (
          <button className="btn-ghost" onClick={onBack} type="button">
            {t('上一步')}
          </button>
        )}
        <button className="btn-ghost" onClick={onComplete} type="button">
          {t('暂时跳过')}
        </button>
        <button
          className="btn-primary"
          disabled={
            !template || !apiKey.trim() || !modelId.trim() || fetching || saving
          }
          onClick={handleSave}>
          {saving ? (
            <span className="btn-loading">
              <span className="btn-spinner" />
              {t('验证中...')}
            </span>
          ) : (
            t('完成，进入对话')
          )}
        </button>
      </div>
    </div>
  )
}

/* ==================== 主流程 ==================== */

function SetupFlow({ onComplete }: Props) {
  const [step, setStep] = useState<'welcome' | 'setWorkdir' | 'setup'>(
    'welcome',
  )
  const [animKey, setAnimKey] = useState(0)

  function goTo(target: typeof step) {
    setStep(target)
    setAnimKey((k) => k + 1)
  }

  return (
    <div className="setup-flow">
      <div className="setup-flow-inner">
        {step === 'welcome' ? (
          /* ====== 第一步：欢迎页 ====== */
          <div className="step-page welcome" key="welcome">
            <div className="welcome-page">
              <div className="welcome-logo">
                <AppLogoSvg size={150} />
              </div>
              <h1 className="welcome-title">{appName}</h1>
              <p className="welcome-subtitle">
                {t(
                  '你的 AI 伙伴，写文案、写代码、理思路、整理文档，都可以交给我。',
                )}
              </p>

              <button
                className="btn-primary btn-start"
                onClick={() => goTo('setWorkdir')}>
                {t('开始使用')}
              </button>
            </div>
          </div>
        ) : step === 'setWorkdir' ? (
          /* ====== 第二步：设置工作目录 ====== */
          <div className="step-page step-enter" key={`workdir-${animKey}`}>
            <SetupWorkdirPage onNext={() => goTo('setup')} />
          </div>
        ) : (
          /* ====== 第三步：模型配置 ====== */
          <div className="step-page step-enter" key={`setup-${animKey}`}>
            <SetupProviderPage
              onBack={() => goTo('setWorkdir')}
              onComplete={onComplete}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default SetupFlow
