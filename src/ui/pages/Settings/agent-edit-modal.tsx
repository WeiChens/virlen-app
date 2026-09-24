/**
 * agent-edit-modal — Agent 编辑/添加弹窗
 *
 * 多 Tab 表单：
 *   1. 基础信息 — 名称、简介
 *   2. 身份设定 — Markdown
 *   3. 性格设定 — Markdown
 *   4. 模型与工作目录 — 默认模型、工作目录
 *   5. 工具选择 — 多选允许的工具列表（按分类分组）
 *   6. 技能选择 — 多选已注册的技能列表
 *
 * 校验与定位：字段校验在提交时统一做（`validate`），失败会**切到出错字段所在的 Tab
 * 并把焦点移进去**（该 Tab 同时打红点）；关闭时有未保存修改会二次确认。
 * 此前只有 Toast 一闪，用户得自己猜哪个字段错了、再自己切回那个 Tab。
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import type { Agent } from '@/types'
import { agentStore } from '@/ui/store'
import { settingsState } from '@/ui/store'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import Select from '@/ui/components/shared/Select'
import { listRegisteredSkills } from '@/skill'
import { t, tpl } from '@/ui/i18n'
import './agent-edit-modal.scss'
import { toolRegistry } from '@/domain/tools'
import { TOOL_CATEGORIES } from '@/domain/tools/category'
import { ResolvedToolDefinition } from '@/domain/tools/types'
import { uuid } from '@/utils/uuid'
import { DEFAULT_PROJECT_RULES_FILE, isSafeProjectRulesPath } from '@/domain/agent/project-rules'

/** 规则文件路径不合法时的统一提示语（输入驳回与保存拦截共用） */
const RULES_FILE_PATH_ERROR =
  '只能是工作目录内的相对路径，不接受绝对路径、盘符、~ 或 ..'

/** 支持 indeterminate 状态的三态复选框组件 */
function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate
    }
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
    />
  )
}

interface Props {
  visible: boolean
  agent: Agent | null
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

/** 「模型与目录」Tab 的下标 */
const TAB_MODEL_AND_DIR = 3

/** 参与校验的字段 */
type FormField = 'name' | 'description' | 'projectRulesFile'

/** 字段 → 所属 Tab（校验失败时定位用） */
const FIELD_TAB: Record<FormField, number> = {
  name: 0,
  description: 0,
  projectRulesFile: TAB_MODEL_AND_DIR,
}

/** 校验顺序 = 定位顺序：取第一个出错的字段 */
const FIELD_ORDER: FormField[] = ['name', 'description', 'projectRulesFile']

/** 表单可比较快照所包含的字段（不含 id / 时间戳，专用于「有未保存修改」判定） */
interface FormValues {
  name: string
  description: string
  identity: string
  personality: string
  providerConfigId: string
  modelId: string
  defaultWorkspace: string
  projectRulesFile: string
  allowTools: string[]
  skills: string[]
  temperature: number
  topP: number
}

/** 派生表单初值：编辑用 Agent 现值，新建用默认值 */
function initialValues(agent: Agent | null): FormValues {
  if (!agent) {
    return {
      name: '',
      description: '',
      identity: '',
      personality: '',
      providerConfigId: '',
      modelId: '',
      defaultWorkspace: settingsState.value.defaultWorkspace,
      projectRulesFile: DEFAULT_PROJECT_RULES_FILE,
      // ⚠️ 新建时工具在初始化 effect 里异步补齐（默认全选），基线快照会跟着刷新
      allowTools: [],
      skills: [],
      temperature: 0.7,
      topP: 1.0,
    }
  }
  return {
    name: agent.name,
    description: agent.description,
    identity: agent.identity,
    personality: agent.personality,
    providerConfigId: agent.defaultModel?.providerConfigId,
    modelId: agent.defaultModel?.modelId,
    defaultWorkspace: agent.defaultWorkspace,
    // 老数据没有该字段 → 显示默认值，保存后落库
    projectRulesFile: agent.projectRulesFile ?? DEFAULT_PROJECT_RULES_FILE,
    allowTools: [...agent.allowTools],
    skills: [...(agent.skills || [])],
    temperature: agent.defaultParams?.temperature ?? 0.7,
    topP: agent.defaultParams?.topP ?? 1.0,
  }
}

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
  const [projectRulesFile, setProjectRulesFile] = useState('')
  /** 字段级校验错误（非空即表示该字段会被驳回；提交时统一刷新） */
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<FormField, string>>
  >({})
  /** 工具 / 技能列表的过滤关键词（27 个工具 + N 个技能只能靠滚，加个检索降负荷） */
  const [toolQuery, setToolQuery] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [allowTools, setAllowTools] = useState<string[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [temperature, setTemperature] = useState(0.7)
  const [topP, setTopP] = useState(1.0)
  const [saving, setSaving] = useState(false)
  /** 提交失败后要把焦点送进的字段（可能跨 Tab：内容是按 Tab 条件渲染的，
   *  切过去之前 ref 还是 null，所以只存字段名、到 effect 里再取节点） */
  const pendingFocus = useRef<FormField | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  /** 表单初值快照（JSON），用于判断「有未保存修改」 */
  const initialRef = useRef('')
  /** 初值是否已就绪（新建 Agent 的工具列表异步补全，就绪前的差异不算用户修改） */
  const [ready, setReady] = useState(false)
  const fieldRefs = {
    name: useRef<HTMLInputElement>(null),
    description: useRef<HTMLTextAreaElement>(null),
    projectRulesFile: useRef<HTMLInputElement>(null),
  }

  /** 当前表单值（与初值快照同构）—— 用于「有未保存修改」判定 */
  const currentValues: FormValues = {
    name,
    description,
    identity,
    personality,
    providerConfigId,
    modelId,
    defaultWorkspace,
    projectRulesFile,
    allowTools,
    skills,
    temperature,
    topP,
  }

  // ===== 可用模型列表 =====
  const providers = settingsState.value.providers.filter((p) => p.enabled)
  const models = useMemo(() => {
    const p = providers.find((p) => p.id === providerConfigId)
    return p ? p.models : []
  }, [providerConfigId, providers])
  const [allTools, setAllTools] = useState([] as ResolvedToolDefinition[])

  /** 工具过滤（名称 / 中文标签 / 描述，大小写不敏感） */
  const filteredTools = useMemo(() => {
    const q = toolQuery.trim().toLowerCase()
    if (!q) return allTools
    return allTools.filter((t) =>
      `${t.name} ${t.label ?? ''} ${t.description}`.toLowerCase().includes(q),
    )
  }, [allTools, toolQuery])

  useEffect(() => {
    ; (async () => {
      const res = await toolRegistry.listDefinitions()
      setAllTools(res)
    })()
  }, [visible])

  // ===== 显隐时初始化 =====
  useEffect(() => {
    if (!visible) return
    const init = initialValues(agent)
    setName(init.name)
    setDescription(init.description)
    setIdentity(init.identity)
    setPersonality(init.personality)
    setProviderConfigId(init.providerConfigId)
    setModelId(init.modelId)
    setDefaultWorkspace(init.defaultWorkspace)
    setProjectRulesFile(init.projectRulesFile)
    setAllowTools(init.allowTools)
    setSkills(init.skills)
    setTemperature(init.temperature)
    setTopP(init.topP)
    // 存量脏配置（手改过 localStorage）原样展示 + 直接报错，逼用户改掉才能保存
    setFieldErrors(
      init.projectRulesFile.trim() &&
        !isSafeProjectRulesPath(init.projectRulesFile)
        ? { projectRulesFile: t(RULES_FILE_PATH_ERROR) }
        : {},
    )
    setTab(0)
    setSaving(false)
    setReady(false)
    setToolQuery('')
    setSkillQuery('')
    initialRef.current = JSON.stringify(init)
    if (agent) {
      setReady(true)
      return
    }
    // 新建 Agent：默认全选所有工具（异步）。补齐后要把基线快照一起刷新，
    // 否则工具一到位就变成「有未保存修改」，点取消会被无谓地拦一次。
    toolRegistry.listAll().then((res) => {
      const names = res.map((t) => t.definition.name)
      setAllowTools(names)
      initialRef.current = JSON.stringify({ ...init, allowTools: names })
      setReady(true)
    })
  }, [visible, agent])

  // 提交失败后把焦点送进出错字段（跨 Tab 时要等 DOM 切过去再取 ref）
  useEffect(() => {
    if (!visible || focusTick === 0) return
    const field = pendingFocus.current
    pendingFocus.current = null
    if (field) fieldRefs[field].current?.focus()
  }, [focusTick, visible])

  // ===== 项目规则文件：输入端驳回非法路径 =====

  /**
   * 校验并应用规则文件路径。
   *
   * **非法输入直接驳回（不写入 state，界面保持上一个合法值）**，同时给出内联错误：
   * 不这样做的话，用户可以用绝对路径把任意文件（如 `~/.ssh/id_rsa`）读进系统提示词，
   * 再随每一次请求原样发给模型服务商。
   *
   * 留空 = 不注入（合法，「清空」是关闭该特性的唯一方式）。
   */
  function applyProjectRulesFile(value: string) {
    if (!value.trim()) {
      setProjectRulesFile('')
      clearFieldError('projectRulesFile')
      return
    }
    if (!isSafeProjectRulesPath(value)) {
      setFieldErrors((prev) => ({
        ...prev,
        projectRulesFile: t(RULES_FILE_PATH_ERROR),
      }))
      return
    }
    setProjectRulesFile(value)
    clearFieldError('projectRulesFile')
  }

  /** 用户开始修正某个字段 → 立刻清掉它的报错（红字不跟着人走） */
  function clearFieldError(field: FormField) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  /** 提交前统一校验；错误按字段返回，空对象 = 通过 */
  function validate(): Partial<Record<FormField, string>> {
    const errors: Partial<Record<FormField, string>> = {}
    if (!name.trim()) errors.name = t('请输入名称')
    if (!description.trim()) errors.description = t('请输入描述')
    // 两件事都要卡住：① 存量脏配置（手改过 localStorage）绕过输入驳回；
    // ② 用户刚被驳回的输入 —— 不做错的话保存会用「旧值」静默成功，
    //    用户以为改成了别的文件，实际什么都没变
    if (projectRulesFile.trim() && !isSafeProjectRulesPath(projectRulesFile)) {
      errors.projectRulesFile = t(RULES_FILE_PATH_ERROR)
    } else if (fieldErrors.projectRulesFile) {
      errors.projectRulesFile = fieldErrors.projectRulesFile
    }
    return errors
  }

  /**
   * 关闭前拦截未保存的修改。
   *
   * 六个 Tab 的表单一次丢弃本就是高代价操作，而此前点「取消」/ ESC / ✕ 是**静默丢弃**：
   * 身份、性格、27 个工具、技能选完了，一个手滑就全没，且无任何挽回入口。
   */
  async function handleClose() {
    if (saving) return
    if (ready && JSON.stringify(currentValues) !== initialRef.current) {
      const ok = await MessageBox.propt(
        t('放弃未保存的修改？'),
        t('当前 Agent 的修改尚未保存，关闭后将丢失。'),
        {
          confirmText: t('放弃修改'),
          cancelText: t('继续编辑'),
          danger: true,
        },
      )
      if (!ok) return
    }
    onClose()
  }

  // ===== 保存 =====
  function handleSave() {
    const errors = validate()
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      // 定位到第一个出错字段：切到它所在的 Tab 并把焦点移进去（Tab 上已打红点）
      const first = FIELD_ORDER.find((f) => errors[f])
      if (first) {
        setTab(FIELD_TAB[first])
        pendingFocus.current = first
        setFocusTick((n) => n + 1)
      }
      return
    }
    setFieldErrors({})

    setSaving(true)

    const now = Date.now()
    const payload: Agent = {
      id: agent?.id || uuid(),
      name: name.trim(),
      description: description.trim(),
      personality: personality.trim(),
      identity: identity.trim(),
      defaultWorkspace: defaultWorkspace.trim(),
      projectRulesFile: projectRulesFile.trim(),
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

  // ===== 工具全选/取消（只作用于当前筛选结果：先搜再全选才是真实意图）=====
  function toggleAllTools() {
    const names = filteredTools.map((t) => t.name)
    if (names.length === 0) return
    const allSelected = names.every((n) => allowTools.includes(n))
    setAllowTools((prev) =>
      allSelected
        ? prev.filter((n) => !names.includes(n))
        : Array.from(new Set([...prev, ...names])),
    )
  }

  // ===== 按分类全选/取消 =====
  function toggleCategory(categoryToolNames: string[], currentlySelected: string[]) {
    const categorySelected = categoryToolNames.filter((name) =>
      currentlySelected.includes(name),
    )
    if (categorySelected.length === categoryToolNames.length) {
      setAllowTools((prev) =>
        prev.filter((t) => !categoryToolNames.includes(t)),
      )
    } else {
      setAllowTools((prev) => {
        const newSet = new Set(prev)
        for (const name of categoryToolNames) {
          newSet.add(name)
        }
        return Array.from(newSet)
      })
    }
  }

  /** 将工具按分类分组，未匹配到分类的工具归入"其他" —— 只分组**过滤后**的列表 */
  const groupedTools = useMemo(() => {
    const grouped: Array<{
      category: (typeof TOOL_CATEGORIES)[0]
      tools: ResolvedToolDefinition[]
    }> = []

    const usedNames = new Set<string>()

    for (const cat of TOOL_CATEGORIES) {
      const tools = filteredTools.filter((t) => cat.toolNames.includes(t.name))
      if (tools.length > 0) {
        grouped.push({ category: cat, tools })
        for (const t of tools) usedNames.add(t.name)
      }
    }

    // 未匹配分类的工具
    const uncategorized = filteredTools.filter((t) => !usedNames.has(t.name))
    if (uncategorized.length > 0) {
      grouped.push({
        category: { id: 'other', label: t('其他'), toolNames: uncategorized.map((t) => t.name) },
        tools: uncategorized,
      })
    }

    return grouped
  }, [filteredTools])

  // ===== 已注册技能列表 =====
  const allSkills = useMemo(
    () => listRegisteredSkills(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible],
  )

  /** 技能过滤（名称 / 描述，大小写不敏感） */
  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase()
    if (!q) return allSkills
    return allSkills.filter((s) =>
      `${s.meta.name} ${s.meta.description}`.toLowerCase().includes(q),
    )
  }, [allSkills, skillQuery])

  // ===== 技能选择切换 =====
  function toggleSkill(skillName: string) {
    setSkills((prev) =>
      prev.includes(skillName)
        ? prev.filter((s) => s !== skillName)
        : [...prev, skillName],
    )
  }

  // ===== 技能全选/取消（同工具：只作用于当前筛选结果）=====
  function toggleAllSkills() {
    const names = filteredSkills.map((s) => s.meta.name)
    if (names.length === 0) return
    const allSelected = names.every((n) => skills.includes(n))
    setSkills((prev) =>
      allSelected
        ? prev.filter((n) => !names.includes(n))
        : Array.from(new Set([...prev, ...names])),
    )
  }

  /**
   * 应用身份 / 性格预设模板。
   *
   * 原实现点一下就把 textarea 整体冲掉，已写的段落找不回来 —— 非空且与预设不同时
   * 先确认一次（空字段则直接填入，不给多余摩擦）。
   */
  async function applyPreset(
    text: string,
    current: string,
    apply: (v: string) => void,
  ) {
    if (current.trim() && current.trim() !== text.trim()) {
      const ok = await MessageBox.propt(
        t('覆盖当前内容？'),
        t('预设模板会整体覆盖当前已填写的内容。'),
        {
          confirmText: t('覆盖'),
          cancelText: t('取消'),
          danger: true,
        },
      )
      if (!ok) return
    }
    apply(text)
  }

  // ===== Tab 键盘导航（ARIA tabs 标准模式：左右方向键 + Home/End）=====
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  function onTabKeyDown(e: React.KeyboardEvent) {
    const last = TAB_NAMES.length - 1
    let next = -1
    if (e.key === 'ArrowRight') next = tab === last ? 0 : tab + 1
    else if (e.key === 'ArrowLeft') next = tab === 0 ? last : tab - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next < 0) return
    e.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
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
      onClose={handleClose}
      width={`min(90vw, 1200px)`}
      className="agent-edit-modal"
      closeOnClickOutside={false}>
      {/* Tab 导航（ARIA tabs 模式：role=tablist/tab + aria-selected，左右方向键切换） */}
      <div
        className="aem-tabs"
        role="tablist"
        aria-label={t('Agent 编辑分页')}
        onKeyDown={onTabKeyDown}>
        {TAB_NAMES.map((name, i) => {
          const hasError = FIELD_ORDER.some(
            (f) => fieldErrors[f] && FIELD_TAB[f] === i,
          )
          return (
            <button
              key={name}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              id={`aem-tab-${i}`}
              role="tab"
              aria-selected={tab === i}
              aria-controls={`aem-panel-${i}`}
              tabIndex={tab === i ? 0 : -1}
              className={`aem-tab ${tab === i ? 'active' : ''}${hasError ? ' has-error' : ''
                }`}
              onClick={() => setTab(i)}>
              {t(name)}
              {hasError && (
                <span
                  className="aem-tab-dot"
                  aria-hidden="true"
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Tab 内容 */}
      <div
        className="aem-body"
        role="tabpanel"
        id={`aem-panel-${tab}`}
        aria-labelledby={`aem-tab-${tab}`}>
        {/* ===== Tab 1: 基础信息 ===== */}
        {tab === 0 && (
          <div className="aem-form">
            <div className="form-group">
              <label htmlFor="agent-name">
                {t('名称')}
                <span className="required">*</span>
              </label>
              <input
                id="agent-name"
                ref={fieldRefs.name}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  clearFieldError('name')
                }}
                placeholder={t('例如：代码助手')}
                autoComplete="off"
                className={fieldErrors.name ? 'input-invalid' : undefined}
                aria-invalid={!!fieldErrors.name}
              />
              {fieldErrors.name && (
                <span className="form-error">{fieldErrors.name}</span>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="agent-desc">
                {t('简短介绍')}
                <span className="required">*</span>
              </label>
              <textarea
                id="agent-desc"
                ref={fieldRefs.description}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value)
                  clearFieldError('description')
                }}
                placeholder={t('用一句话描述这个 Agent 的定位...')}
                rows={2}
                className={
                  fieldErrors.description ? 'input-invalid' : undefined
                }
                aria-invalid={!!fieldErrors.description}
              />
              {fieldErrors.description ? (
                <span className="form-error">{fieldErrors.description}</span>
              ) : (
                <span className="form-hint">
                  {t('介绍会出现在 Agent 列表上，建议不超过 50 字')}
                </span>
              )}
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
          <div className="aem-form" style={{
            height: '100%'
          }}>
            <div className="form-group" style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}>
              <label>{t('身份设定（Markdown）')}</label>
              <div className="presets-row">
                <span className="presets-label">{t('快速模板：')}</span>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t('你是一名拥有 10 年经验的资深软件架构师，精通多种编程语言和设计模式，擅长分布式系统设计、性能优化与代码审查。曾在多家互联网大厂担任技术负责人，对高并发、微服务架构有深入理解。'),
                      identity,
                      setIdentity,
                    )
                  }>
                  {t('编程专家')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t('你是一位资深的创意写作导师，精通叙事结构、人物塑造和语言艺术。曾在知名文学平台担任主编，善于帮助写作者找到独特的声音，提升文字的表现力与感染力。'),
                      identity,
                      setIdentity,
                    )
                  }>
                  {t('写作顾问')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t('你是一名专业的数据科学家，精通统计学、机器学习和数据可视化。拥有多年的数据分析实战经验，善于从海量数据中提取有价值的商业洞察，用数据驱动决策。'),
                      identity,
                      setIdentity,
                    )
                  }>
                  {t('数据分析师')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t('你是一位经验丰富的产品经理，擅长用户需求分析、产品规划和敏捷开发管理。曾主导多款百万级用户产品的从 0 到 1，注重用户体验与商业价值的平衡。'),
                      identity,
                      setIdentity,
                    )
                  }>
                  {t('产品经理')}
                </button>
              </div>
              <textarea
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder={t('例如：\n你是一名拥有 10 年经验的资深架构师，\n擅长分布式系统设计和代码审查。')}
                rows={10}
                className="md-textarea"
              />
            </div>
          </div>
        )}

        {/* ===== Tab 3: 性格设定 ===== */}
        {tab === 2 && (
          <div className="aem-form" style={{
            height: '100%',
          }}>
            <div className="form-group" style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}>
              <label>{t('性格设定（Markdown）')}</label>
              <div className="presets-row">
                <span className="presets-label">{t('快速模板：')}</span>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t(`- 说话严谨、逻辑清晰，注重事实和数据
- 对不确定的信息会明确标注风险
- 回答问题结构化，层次分明
- 保持客观中立，不轻易下结论`),
                      personality,
                      setPersonality,
                    )
                  }>
                  {t('严谨专业')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t(`- 语气亲切温暖，善于鼓励用户
- 用简单易懂的方式解释复杂概念
- 保持积极乐观的态度
- 善于倾听和共情，耐心解答每一个问题`),
                      personality,
                      setPersonality,
                    )
                  }>
                  {t('热情友好')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t(`- 直击要点，不说废话
- 提供可立即执行的建议
- 使用列表和摘要提高可读性
- 优先给出结论，再补充细节`),
                      personality,
                      setPersonality,
                    )
                  }>
                  {t('简洁高效')}
                </button>
                <button
                  className="preset-btn"
                  onClick={() =>
                    applyPreset(
                      t(`- 思维活跃，善于发散联想
- 不拘泥于常规，勇于提出新想法
- 语言生动有趣，善用比喻和故事
- 乐于探讨多种可能性`),
                      personality,
                      setPersonality,
                    )
                  }>
                  {t('创意发散')}
                </button>
              </div>
              <textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                placeholder={t('例如：\n- 说话简洁直接，讨厌冗余\n- 注重代码质量和可维护性\n- 有幽默感，适当使用比喻')}
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
            <div className="form-group">
              <label htmlFor="agent-rules-file">
                {t('项目规则/记忆文件')}
              </label>
              <input
                id="agent-rules-file"
                ref={fieldRefs.projectRulesFile}
                type="text"
                value={projectRulesFile}
                onChange={(e) => applyProjectRulesFile(e.target.value)}
                placeholder={t('例如：AGENTS.md 或 .cursor/rules.md')}
                autoComplete="off"
                className={
                  fieldErrors.projectRulesFile ? 'input-invalid' : undefined
                }
                aria-invalid={!!fieldErrors.projectRulesFile}
              />
              {fieldErrors.projectRulesFile ? (
                <span className="form-error">
                  {fieldErrors.projectRulesFile}
                </span>
              ) : (
                <span className="form-hint">
                  {t(
                    '创建会话时，若工作目录下存在该文件（相对路径），其内容会注入系统提示词；留空则不注入，文件不存在、超过 64 KB 或无法解析时自动跳过',
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ===== Tab 5: 工具选择（按分类分组） ===== */}
        {tab === 4 && (
          <div className="aem-form">
            <div className="form-group">
              <div className="tool-select-header">
                <div>
                  <label>{t('允许使用的工具')}</label>
                  <span className="form-hint">
                    {t('已选')} {allowTools.length} / {allTools.length}
                    {t(' 个工具')}
                    {toolQuery.trim() && (
                      <em className="tool-match-hint">
                        {tpl('（匹配 $__count__ 项）', {
                          count: filteredTools.length,
                        })}
                      </em>
                    )}
                  </span>
                </div>
                <button
                  className="toggle-all-btn"
                  title={t('仅作用于当前筛选结果')}
                  onClick={toggleAllTools}>
                  {filteredTools.every((t) => allowTools.includes(t.name)) &&
                    filteredTools.length > 0
                    ? t('取消全选')
                    : t('全选')}
                </button>
              </div>

              <input
                className="list-filter"
                type="text"
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                placeholder={t('搜索工具（名称 / 描述）')}
                aria-label={t('搜索工具（名称 / 描述）')}
                autoComplete="off"
              />

              {allTools.length === 0 ? (
                <span className="form-hint">{t('暂无可用的工具')}</span>
              ) : filteredTools.length === 0 ? (
                <span className="form-hint">{t('没有匹配的工具')}</span>
              ) : (
                <div className="tool-category-list">
                  {groupedTools.map(({ category, tools }) => {
                    const categorySelected = tools.filter((t) =>
                      allowTools.includes(t.name),
                    )
                    const allInCategorySelected =
                      categorySelected.length === tools.length

                    return (
                      <div key={category.id} className="tool-category-group">
                        <div className="tool-category-header">
                          <label className="tool-category-checkbox">
                            <TriStateCheckbox
                              checked={allInCategorySelected}
                              indeterminate={
                                !allInCategorySelected &&
                                categorySelected.length > 0
                              }
                              onChange={() =>
                                toggleCategory(
                                  tools.map((t) => t.name),
                                  allowTools,
                                )
                              }
                            />
                            <span className="tool-category-name">
                              {category.label}
                            </span>
                          </label>
                          <span className="tool-category-count">
                            {categorySelected.length}/{tools.length}
                          </span>
                        </div>
                        <div className="tool-grid">
                          {tools.map((t) => (
                            <div className="tool-item" key={t.name}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={allowTools.includes(t.name)}
                                  onChange={() => toggleTool(t.name)}
                                />
                                <div>
                                  <div className="tool-name">
                                    {t.label || t.name}
                                  </div>
                                  <div className="tool-id">{t.name}</div>
                                </div>
                                <div className="tool-desc" title={t.description}>
                                  {t.description}
                                </div>
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
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
                    {skillQuery.trim() && (
                      <em className="tool-match-hint">
                        {tpl('（匹配 $__count__ 项）', {
                          count: filteredSkills.length,
                        })}
                      </em>
                    )}
                  </span>
                </div>
                {filteredSkills.length > 0 && (
                  <button
                    className="toggle-all-btn"
                    title={t('仅作用于当前筛选结果')}
                    onClick={toggleAllSkills}>
                    {filteredSkills.every((s) =>
                      skills.includes(s.meta.name),
                    )
                      ? t('取消全选')
                      : t('全选')}
                  </button>
                )}
              </div>

              <input
                className="list-filter"
                type="text"
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.target.value)}
                placeholder={t('搜索技能（名称 / 描述）')}
                aria-label={t('搜索技能（名称 / 描述）')}
                autoComplete="off"
              />

              <div className="tool-grid">
                {filteredSkills.map((s) => (
                  <div className="tool-item" key={s.meta.name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={skills.includes(s.meta.name)}
                        onChange={() => toggleSkill(s.meta.name)}
                      />
                      <span className="tool-name">{s.meta.name}</span>
                      <div className="tool-desc" title={s.meta.description}>
                        {s.meta.description}
                      </div>
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
              {allSkills.length > 0 && filteredSkills.length === 0 && (
                <span className="form-hint">{t('没有匹配的技能')}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部按钮 */}
      <div className="aem-footer">
        <ModalFooterButtons
          onCancel={handleClose}
          onConfirm={handleSave}
          confirmText={isEdit ? t('保存') : t('创建')}
          confirmLoading={saving}
        />
      </div>
    </Modal>
  )
}
