/**
 * mcp-settings — MCP 服务器设置页：列表（状态胶囊 / 工具数 / 审批档）+ 编辑弹窗 + JSON 导入。
 *
 * 数据流（与其它设置页不同，值得说明）：
 * - **配置与运行态都由 Rust 持有**（`app_settings.mcpServers` + `McpManager` 快照），
 *   本页不写 `SettingsStore`，所有写操作都走 `mcpRepo`（`cmd_mcp_*`），成功后重新拉一次列表；
 * - 实时状态来自 `mcp:status` 事件（`services/mcp.ts` 已挂监听 → `mcpStore.applyStatuses`），
 *   因此「连接中 → 已连接」「断线 → 重连中」不需要手动刷新。
 *
 * 为什么「禁用」和「不启用」是两件事：`enabled=false` 与 `approval=deny` 都不建连，
 * 但前者是「暂时关掉」、后者是「永不执行」—— 后者连工具都不下发（模型看不到）。
 */
import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { mcpStore } from '@/ui/store/mcpStore'
import { agentStore } from '@/ui/store/agentStore'
import { mcpRepo } from '@/infrastructure/mcp/repo'
import {
  stateTone,
  type McpServerConfig,
  type McpServerStatus,
} from '@/domain/mcp'
import McpEditModal from './mcp-edit-modal'
import Modal from '@/ui/components/shared/Modal'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import EditSvg from '@/ui/components/icons/EditSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import ReloadSvg from '@/ui/components/icons/ReloadSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import AlertSvg from '@/ui/components/icons/AlertSvg'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import McpSvg from '@/ui/components/icons/McpSvg'
import { t, tpl } from '@/ui/i18n'
import './mcp-settings.scss'

/** 运行态 → 一行文案 */
function stateLabel(status: McpServerStatus | undefined): string {
  if (!status) return t('正在连接…')
  switch (status.state) {
    case 'ready':
      return tpl('已连接 · $__count__ 个工具', { count: status.toolCount })
    case 'connecting':
      return t('正在连接…')
    case 'backoff':
      return tpl('重连中（$__current__/$__max__）', {
        current: status.attempt ?? 0,
        max: status.maxAttempts ?? 0,
      })
    case 'failed':
    case 'error':
      return t('连接失败')
    default:
      return t('已禁用')
  }
}

/** 过渡态（连接中 / 退避重连）：胶囊里的圆点会呼吸，终态保持静止 */
function isPendingState(status: McpServerStatus | undefined): boolean {
  return status?.state === 'connecting' || status?.state === 'backoff'
}

/** 完整启动命令行（详情里要看全：参数被截断就没法拿它去终端里复现） */
function commandLine(config: McpServerConfig): string {
  if (config.transport === 'http') return config.url ?? ''
  return [config.command ?? '', ...(config.args ?? [])].join(' ')
}

/**
 * 这台服务器的工具「被几个 Agent 启用」。
 *
 * 为什么要算这个：`allowTools` 是**穷举白名单**（`undefined` 才是「全部」），
 * 用户连上服务器却看不到工具，最容易踩的就是存量 Agent 里没有这几个名字（方案 §8.6）。
 * 默认 Agent 会在 `mcp:changed` 时自动补入，所以这里的 0 基本等于「自定义 Agent 都没勾」。
 */
function enabledByAgentCount(status: McpServerStatus | undefined): number {
  const names = new Set((status?.tools ?? []).map((tool) => tool.name))
  if (names.size === 0) return 0
  return agentStore.value.agents.filter((agent) =>
    agent.allowTools.some((name) => names.has(name)),
  ).length
}

function McpSettings() {
  const [modal, setModal] = useState<
    { mode: 'add' } | { mode: 'edit'; config: McpServerConfig } | null
  >(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 页面打开拉一次（事件只推「变化」，首次的快照得自己取）
  useEffect(() => {
    void mcpStore.refresh()
  }, [])

  /** 统一的「写操作 + 刷新」包装：失败把原因摆到页面上，不吞 */
  async function run(id: string | null, action: () => Promise<unknown>) {
    setBusyId(id)
    try {
      await action()
      await mcpStore.refresh()
    } catch (e: any) {
      mcpStore.error = e?.message ?? String(e)
      showToast(t('操作失败：') + (e?.message ?? String(e)))
    } finally {
      setBusyId(null)
    }
  }

  async function handleRemove(config: McpServerConfig) {
    const confirmed = await MessageBox.propt(
      t('删除 MCP 服务器'),
      tpl('确定删除「$__name__」？它的连接会被立即关闭，工具也不再对模型可见。', {
        name: config.name,
      }),
      { confirmText: t('删除'), cancelText: t('取消'), danger: true },
    )
    if (!confirmed) return
    await run(config.id, () => mcpRepo.remove(config.id))
  }

  async function handleReconnect(config: McpServerConfig) {
    await run(config.id, () => mcpRepo.reload(config.id))
    showToast(t('重连'))
  }

  async function handleImport() {
    if (!importText.trim()) return
    setImporting(true)
    try {
      const result = await mcpRepo.importJson(importText)
      await mcpStore.refresh()
      const skipped = result.skipped.length
      showToast(
        skipped === 0
          ? tpl('导入成功：$__count__ 个服务器', { count: result.imported.length })
          : tpl('导入成功：$__count__ 个服务器（跳过 $__skipped__ 个）', {
              count: result.imported.length,
              skipped,
            }),
      )
      if (skipped > 0) {
        // 跳过原因逐条摆出来（前端不猜原因，一律用 Rust 给的文案）
        for (const item of result.skipped) {
          showToast(`${item.name}：${item.reason}`)
        }
      }
      setImportOpen(false)
      setImportText('')
    } catch (e: any) {
      showToast(tpl('导入失败：$__reason__', { reason: e?.message ?? String(e) }))
    } finally {
      setImporting(false)
    }
  }

  // 头部计数：一眼看出「几台连上了」，不必逐行读胶囊
  const readyCount = mcpStore.configs.filter(
    (config) => mcpStore.statusOf(config.id)?.state === 'ready',
  ).length

  if (!mcpStore.available) {
    return (
      <div className="mcp-settings">
        <div className="mcp-empty">{t('当前环境不支持 MCP（非桌面应用）')}</div>
      </div>
    )
  }

  return (
    <div className="mcp-settings">
      <div className="mcp-header">
        <div className="mcp-header-text">
          <h3>
            {t('MCP 服务器')}
            {mcpStore.configs.length > 0 && (
              <span className="mcp-header-count">
                {tpl('$__ready__ / $__total__ 台已连接', {
                  ready: readyCount,
                  total: mcpStore.configs.length,
                })}
              </span>
            )}
          </h3>
          <p className="mcp-hint">
            {t('接入外部 MCP 服务器，把它们的工具交给模型调用。')}
          </p>
        </div>
        <div className="mcp-header-actions">
          <button className="btn-secondary" onClick={() => setImportOpen(true)}>
            {t('从 JSON 导入')}
          </button>
          <button className="btn-primary" onClick={() => setModal({ mode: 'add' })}>
            {t('添加服务器')}
          </button>
        </div>
      </div>

      {mcpStore.error && (
        <div className="mcp-banner error" role="alert">
          <AlertSvg />
          <span className="mcp-banner-text">{mcpStore.error}</span>
          <button
            className="icon-btn"
            title={t('关闭')}
            aria-label={t('关闭')}
            onClick={() => {
              mcpStore.error = ''
            }}>
            <CloseSvg />
          </button>
        </div>
      )}

      {mcpStore.configs.length === 0 ? (
        <div className="mcp-empty">
          <span className="mcp-empty-icon" aria-hidden="true">
            <McpSvg />
          </span>
          <p className="mcp-empty-title">{t('还没有 MCP 服务器')}</p>
          <p className="mcp-empty-desc">
            {t('添加一个本地进程或远端地址，它的工具就会出现在模型的工具列表里。')}
          </p>
          <button className="btn-secondary" onClick={() => setModal({ mode: 'add' })}>
            {t('添加服务器')}
          </button>
          <p className="mcp-empty-hint">
            {t('MCP 服务器以你的身份运行，不受本应用的沙盒约束；只添加你信任的来源。')}
          </p>
        </div>
      ) : (
        <div className="mcp-list">
          {mcpStore.configs.map((config) => {
            const status = mcpStore.statusOf(config.id)
            const tone = stateTone(status?.state ?? (config.enabled ? 'connecting' : 'disabled'))
            const busy = busyId === config.id
            const expanded = expandedId === config.id
            return (
              <div
                className={`mcp-row${expanded ? ' expanded' : ''}${busy ? ' is-busy' : ''}`}
                key={config.id}
                aria-busy={busy}>
                {/* 折叠态：独立一块 —— 展开只在它**后面**多插一个面板，
                    cell 自己的列宽 / 行高 / 对齐都不参与重算 */}
                <div className="mcp-row-cell">
                  <div className="mcp-row-title">
                    <span className="mcp-server-name">{config.name}</span>
                    <span className="mcp-badge">{config.transport === 'http' ? 'HTTP' : 'stdio'}</span>
                    {/* 连接态只在「启用」时有意义：停用的服务器不建连，胶囊与开关说的是同一件事 */}
                    {config.enabled ? (
                      <span
                        className={`mcp-capsule tone-${tone}${
                          isPendingState(status) ? ' is-pending' : ''
                        }`}>
                        <span className="mcp-dot" aria-hidden="true" />
                        {stateLabel(status)}
                      </span>
                    ) : (
                      <span className="mcp-badge muted">{t('未启用')}</span>
                    )}
                  </div>
                  {/* 失败原因：折叠时给一行截断摘要；展开后由详情里的呼叫块给全文（不重复两遍） */}
                  {status?.lastError && !expanded && (
                    <div className="mcp-row-error" title={status.lastError}>
                      {status.lastError}
                    </div>
                  )}
                  <div className="mcp-row-actions">
                    <button
                      className="icon-btn"
                      title={t('编辑服务器')}
                      aria-label={t('编辑服务器')}
                      disabled={busy}
                      onClick={() => setModal({ mode: 'edit', config })}>
                      <EditSvg />
                    </button>
                    {/* 展开/收起用箭头（原来的竖三点看着像「更多操作」，实际点开是详情） */}
                    <button
                      className="icon-btn expand-btn"
                      title={expanded ? t('收起详情') : t('展开详情')}
                      aria-label={expanded ? t('收起详情') : t('展开详情')}
                      aria-expanded={expanded}
                      aria-controls={`mcp-details-${config.id}`}
                      onClick={() => setExpandedId(expanded ? null : config.id)}>
                      <DropDownSvg />
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="mcp-row-details" id={`mcp-details-${config.id}`}>
                    {/* 「被几个 Agent 勾了工具」：连接成功后才谈得上，故只在 ready 时给 ——
                        以前挂在行里，列表一长就成了一行干扰信息 */}
                    {status?.state === 'ready' && status.tools.length > 0 && (
                      <p
                        className={`mcp-detail-agents${
                          enabledByAgentCount(status) > 0 ? '' : ' warn'
                        }`}>
                        {enabledByAgentCount(status) > 0
                          ? tpl('已被 $__count__ 个 Agent 启用', {
                              count: enabledByAgentCount(status),
                            })
                          : t('未在任何 Agent 中启用（到 Agent 编辑器的「工具」里勾选）')}
                      </p>
                    )}
                    {/* 观测面板：状态 / 重连次数 / 失败原因 / 服务器自述 / stderr 尾部 ——
                        都是「连不上时该看哪儿」的东西，以前只有 stderr 一项。 */}
                    <div className="details-section">
                      <h4>{t('运行状态')}</h4>
                      <ul className="mcp-diag-list">
                        <li>
                          <span>{t('当前状态')}</span>
                          <span>{stateLabel(status)}</span>
                        </li>
                        {/* 启动命令从行内挪到这里：展开才需要拿它去终端里复现 */}
                        <li>
                          <span>{t('启动命令')}</span>
                          <span>
                            <code className="mcp-diag-code">{commandLine(config)}</code>
                          </span>
                        </li>
                        <li>
                          <span>{t('重连次数')}</span>
                          <span>{status?.reconnectCount ?? 0}</span>
                        </li>
                        {status?.connectedAt != null && (
                          <li>
                            <span>{t('最近连接时间')}</span>
                            <span>{new Date(status.connectedAt).toLocaleString()}</span>
                          </li>
                        )}
                        {status?.serverName && (
                          <li>
                            <span>{t('服务器说明')}</span>
                            <span>
                              {status.serverName}
                              {status.serverVersion ? ` · ${status.serverVersion}` : ''}
                            </span>
                          </li>
                        )}
                      </ul>
                      {/* 失败原因单独成块：折叠时行内只有一行截断摘要，这里要给全文 */}
                      {status?.lastError && (
                        <div className="mcp-callout warn">
                          <AlertSvg />
                          <div className="mcp-callout-body">
                            <strong>{t('最近一次失败原因')}</strong>
                            <span>{status.lastError}</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="details-section">
                      <h4>{tpl('工具（$__count__）', { count: status?.toolCount ?? 0 })}</h4>
                      {status && status.tools.length > 0 ? (
                        <ul className="mcp-tool-list">
                          {status.tools.map((tool) => (
                            <li key={tool.name}>
                              <code>{tool.rawName}</code>
                              <span className="mcp-tool-desc" title={tool.description}>
                                {tool.description}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="details-muted">{t('暂无详情')}</p>
                      )}
                    </div>
                    {status?.stderrTail && (
                      <div className="details-section">
                        <h4>{t('服务器输出（stderr）')}</h4>
                        <pre className="mcp-stderr">{status.stderrTail}</pre>
                      </div>
                    )}
                    {/* 低频 + 破坏性动作放到详情底部：行内只留「编辑 / 展开」两项，
                        既不再挤 5 个图标，也让删除必须先进详情再点（与模型服务页一致） */}
                    <div className="mcp-detail-actions">
                      <button
                        className="btn-secondary"
                        disabled={busy || !config.enabled}
                        onClick={() => void handleReconnect(config)}>
                        <ReloadSvg />
                        {t('重连')}
                      </button>
                      <button
                        className="btn-danger-text"
                        disabled={busy}
                        onClick={() => void handleRemove(config)}>
                        <DeleteSvg />
                        {t('删除')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <McpEditModal
        visible={modal !== null}
        initialConfig={modal?.mode === 'edit' ? modal.config : undefined}
        onClose={() => setModal(null)}
        onSaved={() => {
          setModal(null)
          void mcpStore.refresh()
        }}
      />

      <Modal
        visible={importOpen}
        title={t('从 JSON 导入')}
        width={640}
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setImportOpen(false)}>
              {t('取消')}
            </button>
            <button
              className="btn-primary"
              disabled={importing || !importText.trim()}
              onClick={() => void handleImport()}>
              {t('导入')}
            </button>
          </>
        }>
        <div className="mcp-import-form">
          <p>{t('粘贴 mcpServers 配置')}</p>
          <textarea
            value={importText}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n  }\n}'}
            onChange={(e) => setImportText(e.target.value)}
          />
          <p className="details-muted">
            {t('同名的服务器会被跳过，不会覆盖已有配置。')}
          </p>
        </div>
      </Modal>
    </div>
  )
}

export default observer(McpSettings)
