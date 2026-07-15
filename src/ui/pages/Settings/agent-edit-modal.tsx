/**
 * agent-edit-modal — Agent 编辑/添加弹窗
 *
 * 多 Tab 表单：
 *   1. 基础信息 — 名称、简介
 *   2. 身份设定 — Markdown
 *   3. 性格设定 — Markdown
 *   4. 模型与工作目录 — 默认模型、工作目录
 *   5. 工具选择 — 多选允许的工具列表
 *   6. 技能选择 — 多选已注册的技能列表
 */
import { useState, useEffect, useMemo } from 'react'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import type { Agent } from '@/types'
import { agentStore } from '@/ui/store'
import { settingsState } from '@/ui/store'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import Select from '@/ui/components/shared/Select'
import { listRegisteredSkills } from '@/skill'
import { t } from '@/ui/i18n'
import './agent-edit-modal.scss'
import { showToast } from '@/ui/components/shared/Toast'
import { toolRegistry } from '@/domain/tools'
import { ToolDefinition } from '@/domain/tools/types'
import { uuid } from '@/utils/uuid'

interface Props {
  visible: boolean
  agent: Agent | null // null 表示新建
  onClose: () => void
  onSave: () => void
}

const TAB_NAMES = [
  '基础信息',
  '身份设定',
  '性格设定',
  '模型与目录',
  '工具选择',
  '技能选择',
]

export default function AgentEditModal({
  visible,
  agent,
  onClose,
  onSave,
}: Props) {
  const isEdit = !!agent

  // ===== Form state =====
  const [tab, setTab] = useState(0)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [identity, setIdentity] = useState('')
  const [personality, setPersonality] = useState('')
  const [providerConfigId, setProviderConfigId] = useState('')
  const [modelId, setModelId] = useState('')
  const [defaultWorkspace, setDefaultWorkspace] = useState('')
  const [allowTools, setAllowTools] = useState<string[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [temperature, setTemperature] = useState(0.7)
  const [topP, setTopP] = useState(1.0)
  const [saving, setSaving] = useState(false)

  // ===== 可用模型列表 =====
  const providers = settingsState.value.providers.filter((p) => p.enabled)
  const models = useMemo(() => {
    const p = providers.find((p) => p.id === providerConfigId)
    return p ? p.models : []
  }, [providerConfigId, providers])
  const [allTools, setAllTools] = useState([] as ToolDefinition[])

  useEffect(() => {
    ;(async () => {
      const res = await toolRegistry.listDefinitions()
      setAllTools(res)
    })()
  }, [visible])

  // ===== 显隐时初始化 =====
  useEffect(() => {
    if (visible) {
      if (agent) {
        setName(agent.name)
        setDescription(agent.description)
        setIdentity(agent.identity)
        setPersonality(agent.personality)
        setProviderConfigId(agent.defaultModel?.providerConfigId)
        setModelId(agent.defaultModel?.modelId)
        setDefaultWorkspace(agent.defaultWorkspace)
        setAllowTools([...agent.allowTools])
        setSkills([...(agent.skills || [])])
        setTemperature(agent.defaultParams?.temperature ?? 0.7)
        setTopP(agent.defaultParams?.topP ?? 1.0)
      } else {
        setName('')
        setDescription('')
        setIdentity('')
        setPersonality('')
        setProviderConfigId('')
        setModelId('')
        setDefaultWorkspace(settingsState.value.defaultWorkspace)
        toolRegistry.listAll().then((res) => {
          setAllowTools(res.map((t) => t.definition.name))
        })
        setSkills([])
        setTemperature(0.7)
        setTopP(1.0)
      }
      setTab(0)
      setSaving(false)
    }
  }, [visible, agent])

  // ===== 保存 =====
  function handleSave() {
    if (!name.trim()) {
      showToast(t('请输入名称'))
      setTab(0)
      return
    } else if (!description.trim()) {
      showToast(t('请输入描述'))
      setTab(0)
      return
    }

    setSaving(true)

    const now = Date.now()
    const payload: Agent = {
      id: agent?.id || uuid(),
      name: name.trim(),
      description: description.trim(),
      personality: personality.trim(),
      identity: identity.trim(),
      defaultWorkspace: defaultWorkspace.trim(),
      defaultModel: {
        providerConfigId,
        modelId,
      },
      allowTools,
      skills,
      defaultParams: {
        temperature,
        topP,
      },
      createdAt: agent?.createdAt || now,
      updatedAt: now,
    }
    agentStore.saveAgent(payload)
    setTimeout(() => {
      setSaving(false)
      onSave()
    }, 0)
  }

  // ===== 工具选择切换 =====
  function toggleTool(toolName: string) {
    setAllowTools((prev) =>
      prev.includes(toolName)
        ? prev.filter((t) => t !== toolName)
        : [...prev, toolName],
    )
  }

  // ===== 全选/取消 =====
  function toggleAllTools() {
    if (allowTools.length === allTools.length) {
      setAllowTools([])
    } else {
      setAllowTools(allTools.map((t) => t.name))
    }
  }

  // ===== 已注册技能列表 =====
  const allSkills = useMemo(
    () => listRegisteredSkills(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible],
  )

  // ===== 技能选择切换 =====
  function toggleSkill(skillName: string) {
    setSkills((prev) =>
      prev.includes(skillName)
        ? prev.filter((s) => s !== skillName)
        : [...prev, skillName],
    )
  }

  // ===== 技能全选/取消 =====
  function toggleAllSkills() {
    if (skills.length === allSkills.length) {
      setSkills([])
    } else {
      setSkills(allSkills.map((s) => s.meta.name))
    }
  }

  // ===== 文件夹选择 =====
  async function pickFolder() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: defaultWorkspace,
      })
      if (selected) {
        setDefaultWorkspace(selected.replace(/\\/g, '/'))
      }
    } catch {
      // 非 Tauri 环境忽略
    }
  }

  return (
    <Modal
      move
      visible={visible}
      title={isEdit ? t('编辑 Agent') : t('新建 Agent')}
      onClose={onClose}
      width={580}
      className="agent-edit-modal"
      closeOnClickOutside={false}>
      {/* Tab 导航 */}
      <div className="aem-tabs">
        {TAB_NAMES.map((name, i) => (
          <button
            key={name}
            className={`aem-tab ${tab === i ? 'active' : ''}`}
            onClick={() => setTab(i)}>
            {t(name)}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className="aem-body">
        {/* ===== Tab 1: 基础信息 ===== */}
        {tab === 0 && (
          <div className="aem-form">
            <div className="form-group">
              <label htmlFor="agent-name">{t('名称')}</label>
              <input
                id="agent-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('例如：代码助手')}
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label htmlFor="agent-desc">{t('简短介绍')}</label>
              <textarea
                id="agent-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('用一句话描述这个 Agent 的定位...')}
                rows={2}
              />
              <span className="form-hint">
                {t('介绍会出现在 Agent 列表上，建议不超过 50 字')}
              </span>
            </div>
            <div className="form-group params-row">
              <div className="param-item" style={{ width: '50%' }}>
                <label htmlFor="agent-temperature">
                  Temperature
                  <span className="param-value">{temperature.toFixed(1)}</span>
                </label>
                <input
                  id="agent-temperature"
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                />
                <span className="param-hint">
                  {t('越低越确定，越高越有创造性（默认 0.7）')}
                </span>
              </div>
              <div className="param-item" style={{ width: '50%' }}>
                <label htmlFor="agent-topP">
                  Top P<span className="param-value">{topP.toFixed(2)}</span>
                </label>
                <input
                  id="agent-topP"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value))}
                />
                <span className="param-hint">
                  {t('核采样阈值，越低越保守（默认 1.0）')}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ===== Tab 2: 身份设定 ===== */}
        {tab === 1 && (
          <div className="aem-form">
            <div className="form-group">
              <label>{t('身份设定（Markdown）')}</label>
              <div className="presets-row">
                <span className="presets-label">{t('快速模板：')}</span>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setIdentity(
                      `你是一名拥有 10 年经验的资深软件架构师，精通多种编程语言和设计模式，擅长分布式系统设计、性能优化与代码审查。曾在多家互联网大厂担任技术负责人，对高并发、微服务架构有深入理解。`,
                    )
                  }>
                  {t('编程专家')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setIdentity(
                      `你是一位资深的创意写作导师，精通叙事结构、人物塑造和语言艺术。曾在知名文学平台担任主编，善于帮助写作者找到独特的声音，提升文字的表现力与感染力。`,
                    )
                  }>
                  {t('写作顾问')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setIdentity(
                      `你是一名专业的数据科学家，精通统计学、机器学习和数据可视化。拥有多年的数据分析实战经验，善于从海量数据中提取有价值的商业洞察，用数据驱动决策。`,
                    )
                  }>
                  {t('数据分析师')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setIdentity(
                      `你是一位经验丰富的产品经理，擅长用户需求分析、产品规划和敏捷开发管理。曾主导多款百万级用户产品的从 0 到 1，注重用户体验与商业价值的平衡。`,
                    )
                  }>
                  {t('产品经理')}
                </button>
              </div>
              <textarea
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder={`${t('例如：')}\n你是一名拥有 10 年经验的资深架构师，\n擅长分布式系统设计和代码审查。`}
                rows={10}
                className="md-textarea"
              />
            </div>
          </div>
        )}

        {/* ===== Tab 3: 性格设定 ===== */}
        {tab === 2 && (
          <div className="aem-form">
            <div className="form-group">
              <label>{t('性格设定（Markdown）')}</label>
              <div className="presets-row">
                <span className="presets-label">{t('快速模板：')}</span>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setPersonality(`- 说话严谨、逻辑清晰，注重事实和数据
- 对不确定的信息会明确标注风险
- 回答问题结构化，层次分明
- 保持客观中立，不轻易下结论`)
                  }>
                  {t('严谨专业')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setPersonality(`- 语气亲切温暖，善于鼓励用户
- 用简单易懂的方式解释复杂概念
- 保持积极乐观的态度
- 善于倾听和共情，耐心解答每一个问题`)
                  }>
                  {t('热情友好')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setPersonality(`- 直击要点，不说废话
- 提供可立即执行的建议
- 使用列表和摘要提高可读性
- 优先给出结论，再补充细节`)
                  }>
                  {t('简洁高效')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    setPersonality(`- 思维活跃，善于发散联想
- 不拘泥于常规，勇于提出新想法
- 语言生动有趣，善用比喻和故事
- 乐于探讨多种可能性`)
                  }>
                  {t('创意发散')}
                </button>
              </div>
              <textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                placeholder={`${t('例如：')}\n- 说话简洁直接，讨厌冗余\n- 注重代码质量和可维护性\n- 有幽默感，适当使用比喻`}
                rows={10}
                className="md-textarea"
              />
            </div>
          </div>
        )}

        {/* ===== Tab 4: 模型与目录 ===== */}
        {tab === 3 && (
          <div className="aem-form">
            <div className="form-group">
              <label htmlFor="agent-provider">{t('默认模型')}</label>
              <div className="model-select-row">
                <Select
                  value={providerConfigId}
                  onChange={(v) => {
                    setProviderConfigId(v)
                    setModelId('')
                  }}
                  options={[
                    { value: '', label: t('-- 未设置 --') },
                    ...providers.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  placeholder={t('-- 未设置 --')}
                  width={180}
                />
                <Select
                  value={modelId}
                  onChange={(v) => setModelId(v)}
                  disabled={!providerConfigId}
                  options={[
                    { value: '', label: t('-- 选择模型 --') },
                    ...models.map((m) => ({ value: m, label: m })),
                  ]}
                  placeholder={t('-- 选择模型 --')}
                  width={180}
                />
              </div>
              <span className="form-hint">
                {t('创建会话时将自动使用此模型，用户可在会话中切换')}
              </span>
            </div>
            <div className="form-group">
              <label htmlFor="agent-workspace">{t('工作目录')}</label>
              <div className="input-with-btn">
                <input
                  id="agent-workspace"
                  type="text"
                  value={defaultWorkspace}
                  onChange={(e) => setDefaultWorkspace(e.target.value)}
                  placeholder={t('例如：/home/user/projects 或留空')}
                  autoComplete="off"
                />
                <button
                  className="folder-btn"
                  onClick={pickFolder}
                  title={t('选择目录')}
                  type="button">
                  <FolderSvg fill="var(--bg-primary)" />
                </button>
              </div>
              <span className="form-hint">
                {t('设置后，该 Agent 创建的会话默认以此目录为工作区')}
              </span>
            </div>
          </div>
        )}

        {/* ===== Tab 5: 工具选择 ===== */}
        {tab === 4 && (
          <div className="aem-form">
            <div className="form-group">
              <div className="tool-select-header">
                <div>
                  <label>{t('允许使用的工具')}</label>
                  <span className="form-hint">
                    {t('已选')} {allowTools.length} / {allTools.length}
                    {t(' 个工具')}
                  </span>
                </div>
                <button className="toggle-all-btn" onClick={toggleAllTools}>
                  {allowTools.length === allTools.length
                    ? t('取消全选')
                    : t('全选')}
                </button>
              </div>

              <div className="tool-grid">
                {allTools.map((t) => (
                  <div className="tool-item" key={t.name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={allowTools.includes(t.name)}
                        onChange={() => toggleTool(t.name)}
                      />
                      <div>
                        <div className="tool-name">{t.label || t.name}</div>
                        <div className="tool-id">{t.name}</div>
                      </div>
                      <div className="tool-desc">{t.description}</div>
                    </label>
                  </div>
                ))}
              </div>
              {allTools.length === 0 && (
                <span className="form-hint">{t('暂无可用的工具')}</span>
              )}
            </div>
          </div>
        )}

        {/* ===== Tab 6: 技能选择 ===== */}
        {tab === 5 && (
          <div className="aem-form">
            <div className="form-group">
              <div className="tool-select-header">
                <div>
                  <label>{t('已注册的技能')}</label>
                  <span className="form-hint">
                    {t('已选')} {skills.length} / {allSkills.length}
                    {t('个技能')}
                  </span>
                </div>
                {allSkills.length > 0 && (
                  <button className="toggle-all-btn" onClick={toggleAllSkills}>
                    {skills.length === allSkills.length
                      ? t('取消全选')
                      : t('全选')}
                  </button>
                )}
              </div>

              <div className="tool-grid">
                {allSkills.map((s) => (
                  <div className="tool-item" key={s.meta.name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={skills.includes(s.meta.name)}
                        onChange={() => toggleSkill(s.meta.name)}
                      />
                      <span className="tool-name">{s.meta.name}</span>
                      <div className="tool-desc">{s.meta.description}</div>
                    </label>
                  </div>
                ))}
              </div>
              {allSkills.length === 0 && (
                <div className="no-skills-hint">
                  <span className="form-hint">
                    {t('暂未注册任何技能。请在设置页面导入技能 ZIP 包后刷新。')}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部按钮 */}
      <div className="aem-footer">
        <ModalFooterButtons
          onCancel={onClose}
          onConfirm={handleSave}
          confirmText={isEdit ? t('保存') : t('创建')}
          confirmLoading={saving}
        />
      </div>
    </Modal>
  )
}
