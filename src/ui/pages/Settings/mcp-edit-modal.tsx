/**
 * mcp-edit-modal — 新增 / 编辑一台 MCP 服务器。
 *
 * 只做「把表单收成一条 `McpServerConfig`」，落库与校验的最终裁决都在 Rust
 * （`cmd_mcp_upsert` → `mcp::config::validate`）。这里的本地校验只为少一次往返。
 *
 * 「测试连接」（`cmd_mcp_test`）走的是**真实的连接链**（与正式运行同一条监督器），
 * 只是连完立刻 dispose —— 因此它测得出 Windows 的 `.cmd` 垫片、环境清洗、协议版本回退，
 * 也测得出「命令拼错」。
 */
import { useEffect, useState } from 'react'
import Modal from '@/ui/components/shared/Modal'
import Select from '@/ui/components/shared/Select'
import Toggle from '@/ui/components/shared/Toggle'
import { showToast } from '@/ui/components/shared/Toast'
import { mcpRepo } from '@/infrastructure/mcp/repo'
import {
  MCP_APPROVAL_OPTIONS,
  argsToText,
  createMcpServerDraft,
  headersToText,
  pairsToText,
  textToArgs,
  textToHeaders,
  textToPairs,
  validateMcpConfig,
  type McpApproval,
  type McpProbeResult,
  type McpServerConfig,
  type McpToolInfo,
  type McpTransportKind,
} from '@/domain/mcp'
import { t, tpl } from '@/ui/i18n'
import AlertSvg from '@/ui/components/icons/AlertSvg'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import './mcp-edit-modal.scss'

interface Props {
  visible: boolean
  /** 编辑模式传已有配置；新增模式不传（从空白草稿开始） */
  initialConfig?: McpServerConfig
  onClose: () => void
  onSaved: () => void
}

function approvalLabel(value: McpApproval): string {
  if (value === 'allow') return t('直接执行')
  if (value === 'deny') return t('禁用')
  return t('每次调用都确认')
}

/**
 * 探测到的工具 → 初始勾选。
 *
 * 存量白名单存在就按它勾（逐字对应服务器自己的 rawName），没有就全选 —— 新增服务器
 * 永远是「全部交给模型」，想收窄再逐个取消（白名单是穷举的，少勾一个等于少给一个工具）。
 */
function initialToolSelection(tools: McpToolInfo[], whitelist?: string[]): string[] {
  const names = tools.map((tool) => tool.rawName)
  if (!whitelist) return names
  return names.filter((name) => whitelist.includes(name))
}

/**
 * 勾选 → 落库白名单：**全选写 `undefined`**（Rust 语义「不限制」，新增工具自动包含），
 * 全部取消写 `[]`（一个都不暴露，空数组不等于「全部」）。
 */
function selectionToWhitelist(
  tools: McpToolInfo[],
  selected: string[],
): string[] | undefined {
  const names = tools.map((tool) => tool.rawName)
  if (names.every((name) => selected.includes(name))) return undefined
  return names.filter((name) => selected.includes(name))
}

export default function McpEditModal({
  visible,
  initialConfig,
  onClose,
  onSaved,
}: Props) {
  const isEdit = !!initialConfig
  /** 新增模式的稳定 id："测试连接"与"保存"必须用同一个 id（否则每点一次就换一个身份） */
  const [draftId, setDraftId] = useState('')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransportKind>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [cwd, setCwd] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [approval, setApproval] = useState<McpApproval>('ask')
  const [toolCallTimeoutMs, setToolCallTimeoutMs] = useState(60_000)
  const [startupTimeoutMs, setStartupTimeoutMs] = useState(30_000)
  const [reconnectEnabled, setReconnectEnabled] = useState(true)
  const [injectInstructions, setInjectInstructions] = useState(true)
  const [enabled, setEnabled] = useState(true)
  /** 勾选的工具（rawName）。`null` = 还没探测过，首次探测后按白名单 / 全选初始化 */
  const [selectedTools, setSelectedTools] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<McpProbeResult | null>(null)

  // 打开时按来源回填（新增 = 空白草稿；编辑 = 已有配置）
  useEffect(() => {
    if (!visible) return
    const draft = initialConfig ?? createMcpServerDraft('stdio')
    setDraftId(draft.id)
    setName(draft.name)
    setTransport(draft.transport)
    setCommand(draft.command ?? '')
    setArgsText(argsToText(draft.args))
    setCwd(draft.cwd ?? '')
    setEnvText(pairsToText(draft.env))
    setUrl(draft.url ?? '')
    setHeadersText(headersToText(draft.headers))
    setApproval(draft.approval)
    setToolCallTimeoutMs(draft.toolCallTimeoutMs)
    setStartupTimeoutMs(draft.startupTimeoutMs)
    setReconnectEnabled(draft.reconnect.enabled)
    setInjectInstructions(draft.injectInstructions)
    setEnabled(draft.enabled)
    setSelectedTools(null)
    setProbe(null)
    setSaving(false)
    setTesting(false)
  }, [visible, initialConfig])

  /** 停用或审批为「禁用」时不会建连：这类配置不要求先测（Rust 的探针也会直接拒绝） */
  const needsProbe = enabled && approval !== 'deny'

  /** 表单 → 配置（保存与「测试连接」共用同一条组装，避免两处漂移） */
  function buildConfig(): McpServerConfig {
    const base = initialConfig ?? {
      ...createMcpServerDraft(transport),
      id: draftId || createMcpServerDraft(transport).id,
    }
    const config: McpServerConfig = {
      ...base,
      name: name.trim(),
      transport,
      approval,
      toolCallTimeoutMs: Number(toolCallTimeoutMs) || 0,
      startupTimeoutMs: Number(startupTimeoutMs) || 0,
      reconnect: { ...base.reconnect, enabled: reconnectEnabled },
      injectInstructions,
      enabled,
      // 有探测结果就按勾选写回；没有（停用 / 禁用 / 未测）就沿用原配置，不凭 UI 猜
      enabledTools: probe?.ok
        ? selectionToWhitelist(probe.tools, selectedTools ?? [])
        : initialConfig?.enabledTools,
    }
    if (transport === 'stdio') {
      config.command = command.trim()
      config.args = textToArgs(argsText)
      config.cwd = cwd.trim() ? cwd.trim() : undefined
      config.env = textToPairs(envText)
      // 切传输时清掉另一侧的字段：留着会让配置里同时出现 url 与 command（Rust 侧按 tag 解析，
      // 多出来的键会被忽略，但设置页回填时就会看到「明明是 stdio 却有 url」）
      config.url = undefined
      config.headers = undefined
    } else {
      config.url = url.trim()
      config.headers = textToHeaders(headersText)
      config.command = undefined
      config.args = undefined
      config.cwd = undefined
      config.env = undefined
    }
    return config
  }

  /** 连接参数一变，上一次探测就过期了：清掉结果（保存门禁随之重新关上） */
  function invalidateProbe() {
    setProbe(null)
  }

  /** 全选 / 取消全选（只作用于服务器实际提供的工具） */
  function toggleAllTools() {
    if (!probe?.ok) return
    const names = probe.tools.map((tool) => tool.rawName)
    const allChecked = names.every((name) => (selectedTools ?? []).includes(name))
    setSelectedTools(allChecked ? [] : names)
  }

  function toggleTool(rawName: string) {
    setSelectedTools((current) => {
      const base = current ?? []
      return base.includes(rawName)
        ? base.filter((name) => name !== rawName)
        : [...base, rawName]
    })
  }

  async function handleTest() {
    const config = buildConfig()
    const error = validateMcpConfig(config)
    if (error) {
      showToast(error)
      return
    }
    setTesting(true)
    setProbe(null)
    try {
      // 探测只关心「服务器给什么工具」：白名单由下面的勾选面板处理。
      // 带着旧白名单去测，Rust 侧会把它当成上限把清单裁掉，面板就再也勾不回来了。
      const result = await mcpRepo.test({ ...config, enabledTools: undefined })
      setProbe(result)
      if (result.ok) {
        setSelectedTools((current) => {
          const names = result.tools.map((tool) => tool.rawName)
          // 首次探测：有存量白名单就按它勾，没有就全选；重测则保留用户手改过的勾选
          return current === null
            ? initialToolSelection(result.tools, initialConfig?.enabledTools)
            : names.filter((name) => current.includes(name))
        })
      }
    } catch (e: any) {
      setProbe({ ok: false, toolCount: 0, tools: [], error: e?.message ?? String(e) })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    // 没有工具清单就不允许保存：白名单是穷举的，猜错的一行等于一个工具都看不到
    if (needsProbe && !probe?.ok) {
      showToast(t('先测试连接，读到工具列表后才能保存'))
      return
    }
    const config = buildConfig()
    const error = validateMcpConfig(config)
    if (error) {
      showToast(error)
      return
    }
    setSaving(true)
    try {
      await mcpRepo.upsert(config)
      onSaved()
    } catch (e: any) {
      showToast(e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      visible={visible}
      title={isEdit ? t('编辑服务器') : t('添加服务器')}
      width={640}
      onClose={onClose}
      footer={
        <>
          {/* 保存门禁前置说明：按钮置灰时得让用户知道「差哪一步」 */}
          {needsProbe && !probe?.ok && (
            <span className="mcp-footer-hint">
              {t('先测试连接，读到工具列表后才能保存')}
            </span>
          )}
          <button className="btn-secondary" onClick={onClose}>
            {t('取消')}
          </button>
          <button
            className="btn-secondary"
            disabled={testing || !needsProbe}
            title={
              !needsProbe
                ? t('服务器已停用或审批方式为「禁用」，不会建立连接。')
                : undefined
            }
            onClick={() => void handleTest()}>
            {testing ? t('正在连接…') : t('测试连接')}
          </button>
          <button
            className="btn-primary"
            disabled={saving || testing || (needsProbe && !probe?.ok)}
            title={
              needsProbe && !probe?.ok
                ? t('先测试连接，读到工具列表后才能保存')
                : undefined
            }
            onClick={() => void handleSave()}>
            {t('保存')}
          </button>
        </>
      }>
      <div className="mcp-edit-form">
        <div className="form-group">
          <label htmlFor="mcp-name">{t('服务器名称')}</label>
          <input
            id="mcp-name"
            type="text"
            value={name}
            spellCheck={false}
            placeholder="filesystem"
            aria-describedby="mcp-name-hint"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="form-hint" id="mcp-name-hint">
            {t('用作工具名前缀（mcp__名称__工具）。改名会让已有会话里的工具名失效。')}
          </p>
        </div>

        <div className="form-group">
          <label>{t('传输方式')}</label>
          <div className="transport-switch">
            <button
              className={transport === 'stdio' ? 'active' : ''}
              onClick={() => {
                setTransport('stdio')
                invalidateProbe()
              }}
              type="button">
              {t('标准输入输出（本地进程）')}
            </button>
            <button
              className={transport === 'http' ? 'active' : ''}
              onClick={() => {
                setTransport('http')
                invalidateProbe()
              }}
              type="button">
              {t('HTTP（远端）')}
            </button>
          </div>
        </div>

        {transport === 'stdio' ? (
          <>
            <div className="form-group">
              <label htmlFor="mcp-command">{t('命令')}</label>
              <input
                id="mcp-command"
                type="text"
                value={command}
                spellCheck={false}
                placeholder="npx"
                aria-describedby="mcp-command-hint"
                onChange={(e) => {
                  setCommand(e.target.value)
                  invalidateProbe()
                }}
              />
              <p className="form-hint" id="mcp-command-hint">
                {t('Windows 上 npx / pnpm / uvx 这类垫片会自动经 cmd 执行；命令写错会直接报「找不到命令」。')}
              </p>
            </div>
            <div className="form-group">
              <label htmlFor="mcp-args">{t('参数（每行一个）')}</label>
              <textarea
                id="mcp-args"
                value={argsText}
                spellCheck={false}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
                onChange={(e) => {
                  setArgsText(e.target.value)
                  invalidateProbe()
                }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="mcp-cwd">{t('工作目录')}</label>
              <input
                id="mcp-cwd"
                type="text"
                value={cwd}
                spellCheck={false}
                placeholder={t('留空 = 继承当前进程')}
                onChange={(e) => {
                  setCwd(e.target.value)
                  invalidateProbe()
                }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="mcp-env">{t('环境变量')}</label>
              <textarea
                id="mcp-env"
                value={envText}
                spellCheck={false}
                placeholder={'FOO=bar'}
                aria-describedby="mcp-env-hint"
                onChange={(e) => {
                  setEnvText(e.target.value)
                  invalidateProbe()
                }}
              />
              <p className="form-hint" id="mcp-env-hint">
                {t('每行一个 KEY=value。名字像密钥的父进程环境变量不会传给它（KEY/PASSWORD/SECRET/TOKEN）。')}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="form-group">
              <label htmlFor="mcp-url">URL</label>
              <input
                id="mcp-url"
                type="text"
                value={url}
                spellCheck={false}
                placeholder="https://mcp.example.com/mcp"
                onChange={(e) => {
                  setUrl(e.target.value)
                  invalidateProbe()
                }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="mcp-headers">{t('请求头')}</label>
              <textarea
                id="mcp-headers"
                value={headersText}
                spellCheck={false}
                placeholder={'Authorization: Bearer <token>'}
                aria-describedby="mcp-headers-hint"
                onChange={(e) => {
                  setHeadersText(e.target.value)
                  invalidateProbe()
                }}
              />
              <p className="form-hint" id="mcp-headers-hint">{t('每行一个 Name: value。')}</p>
            </div>
          </>
        )}

        <div className="form-row">
          <div className="form-group">
            {/* 原生 <select> 在深色主题下只有系统配色，且宽度不受控 → 统一走公共 Select */}
            <label>{t('审批方式')}</label>
            <Select
              className="mcp-approval-select"
              value={approval}
              options={MCP_APPROVAL_OPTIONS.map((option) => ({
                value: option.value,
                label: approvalLabel(option.value),
              }))}
              ariaLabel={t('审批方式')}
              width="100%"
              onChange={(next) => setApproval(next as McpApproval)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="mcp-call-timeout">{t('单次调用超时（毫秒）')}</label>
            <input
              id="mcp-call-timeout"
              type="number"
              min={1}
              value={toolCallTimeoutMs}
              onChange={(e) => setToolCallTimeoutMs(Number(e.target.value))}
            />
          </div>
          <div className="form-group">
            <label htmlFor="mcp-startup-timeout">{t('启动超时（毫秒）')}</label>
            <input
              id="mcp-startup-timeout"
              type="number"
              min={1}
              value={startupTimeoutMs}
              onChange={(e) => setStartupTimeoutMs(Number(e.target.value))}
            />
          </div>
        </div>

        {/* 工具清单 = 「测试连接」的结果：连上才知道服务器有哪些工具，
            勾选决定交给模型哪些（默认全选）。所以保存前必须先测通 —— 白名单是穷举的，
            以前靠手敲名字，填错一个字就是 0 个工具。 */}
        <div className="form-section">
          <div className="tools-head">
            <h4 className="form-section-title">{t('工具选择')}</h4>
            {needsProbe && probe?.ok && (
              <span className="tools-count">
                {tpl('已连接 · $__count__ 个工具', { count: probe.toolCount })}
              </span>
            )}
          </div>

          {!needsProbe ? (
            <p className="form-hint">
              {t('服务器已停用或审批方式为「禁用」，不会建立连接；工具清单保持原有设置。')}
            </p>
          ) : probe?.ok ? (
            probe.tools.length === 0 ? (
              <p className="form-hint">{t('这台服务器没有提供任何工具。')}</p>
            ) : (
              <>
                <div className="tools-bar">
                  <span>
                    {tpl('已选 $__done__/$__all__', {
                      done: selectedTools?.length ?? 0,
                      all: probe.tools.length,
                    })}
                  </span>
                  <button type="button" className="link-btn" onClick={toggleAllTools}>
                    {(selectedTools?.length ?? 0) >= probe.tools.length
                      ? t('取消全选')
                      : t('全选')}
                  </button>
                </div>
                <ul className="mcp-tool-picker">
                  {probe.tools.map((tool) => (
                    <li key={tool.name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedTools?.includes(tool.rawName) ?? false}
                          onChange={() => toggleTool(tool.rawName)}
                        />
                        <span className="picker-text">
                          {/* 列的是服务器自己的名字（白名单也用它），公开名挂 title */}
                          <code title={tool.name}>{tool.rawName}</code>
                          {tool.description && (
                            <span className="picker-desc" title={tool.description}>
                              {tool.description}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="form-hint">{t('未勾选的工具不会交给模型。')}</p>
              </>
            )
          ) : probe ? (
            <div className="probe-result error" role="status">
              <div className="probe-head">
                <span className="probe-dot" aria-hidden="true" />
                <strong className="probe-title">
                  {probe.error || t('连接失败')}
                </strong>
                <button
                  className="probe-close"
                  title={t('关闭')}
                  aria-label={t('关闭')}
                  onClick={() => setProbe(null)}>
                  <CloseSvg />
                </button>
              </div>
              <p className="probe-hint">
                <AlertSvg />
                <span>
                  {t('常见原因：命令写错、依赖未安装、端口未开放，或服务器输出的不是 UTF-8。')}
                </span>
              </p>
            </div>
          ) : (
            <p className="form-hint">{t('先测试连接：连上后会自动列出这台服务器的工具。')}</p>
          )}
        </div>

        {/* 选项成组：三枚开关各带一句后果说明，避免「这个开关到底影响什么」 */}
        <div className="form-section">
          <h4 className="form-section-title">{t('选项')}</h4>
          <div className="form-switches">
            <div className="switch-row">
              <div className="switch-text">
                <span className="switch-title">{t('启用')}</span>
                <span className="switch-hint">
                  {/* 启用时的风险提醒只能摆在这里：行内的开关已收进弹窗，没有地方再弹一次确认 */}
                  {enabled
                    ? t('启用后该服务器将以你的身份读写文件、访问网络。只添加你信任的服务器。')
                    : t('停用后不建立连接，工具对模型不可见。')}
                </span>
              </div>
              <Toggle checked={enabled} onChange={setEnabled} size="sm" ariaLabel={t('启用')} />
            </div>
            <div className="switch-row">
              <div className="switch-text">
                <span className="switch-title">{t('自动重连')}</span>
                <span className="switch-hint">
                  {t('断线后按 0.5s → 1s → 2s… 退避重试，预算耗尽才报失败。')}
                </span>
              </div>
              <Toggle
                checked={reconnectEnabled}
                onChange={setReconnectEnabled}
                size="sm"
                ariaLabel={t('自动重连')}
              />
            </div>
            <div className="switch-row">
              <div className="switch-text">
                <span className="switch-title">{t('注入服务器说明')}</span>
                <span className="switch-hint">
                  {t('把服务器 initialize 时返回的说明书作为背景知识注入系统提示词。')}
                </span>
              </div>
              <Toggle
                checked={injectInstructions}
                onChange={setInjectInstructions}
                size="sm"
                ariaLabel={t('注入服务器说明')}
              />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
