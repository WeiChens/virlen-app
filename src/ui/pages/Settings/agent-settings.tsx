/**
 * agent-settings — Agent 管理页面
 *
 * 紧凑列表布局展示所有 Agent，点击进入编辑。
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { agentStore } from '@/ui/store'
import type { Agent } from '@/types'
import AgentEditModal from './agent-edit-modal'
import AddSvg from '@/ui/components/icons/AddSvg'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { t, tpl } from '@/ui/i18n'
import './agent-settings.scss'
import { DEFAULT_AGENT_ID } from '@/ui/constants'

function AgentSettings() {
  const [showModal, setShowModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const agents = agentStore.listAgents()
  const defaultAgentId = DEFAULT_AGENT_ID

  function handleAdd() {
    setEditingAgent(null)
    setShowModal(true)
  }

  function handleEdit(agent: Agent) {
    setEditingAgent(agent)
    setShowModal(true)
  }

  async function handleDelete(agent: Agent) {
    if (agent.id === defaultAgentId) {
      showToast(t('默认 Agent 不可删除'), 1500)
      return
    }
    const confirmed = await MessageBox.propt(
      t('删除 Agent'),
      tpl('确定删除「$__name__」？$__reason__', {
        name: agent.name,
        reason: t('此操作不可撤销。'),
      }),
      { confirmText: t('删除'), cancelText: t('取消') },
    )
    if (!confirmed) return
    const ok = agentStore.deleteAgent(agent.id)
    if (ok) {
      showToast(t('已删除'), 1000)
    }
  }

  function handleSave() {
    setShowModal(false)
    setEditingAgent(null)
    showToast(editingAgent ? t('已更新') : t('已创建'), 1000)
  }

  return (
    <div className="agent-settings">
      <div className="agent-header">
        <h2 className="section-title">{t('Agent 管理')}</h2>
        <button className="agent-add-btn" onClick={handleAdd}>
          <AddSvg />
          <span>{t('新建 Agent')}</span>
        </button>
      </div>

      <div className="agent-list">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="agent-item"
            onClick={() => handleEdit(agent)}>
            <div className="agent-item-main">
              <div className="row">
                <span className="agent-item-name">{agent.name}</span>
                <div className="agent-item-meta">
                  <span className="agent-item-tools">
                    {agent.allowTools.length > 0
                      ? `${agent.allowTools.length}${t(' 个工具')}`
                      : t('无工具')}
                  </span>
                  {agent.id === defaultAgentId && (
                    <span className="agent-item-badge">{t('默认')}</span>
                  )}
                </div>
              </div>
              {agent.description && (
                <span className="agent-item-desc">{agent.description}</span>
              )}
            </div>
            <div
              className="agent-item-actions"
              onClick={(e) => e.stopPropagation()}>
              {/* <button
                className="agent-action-btn"
                title="编辑"
                onClick={() => handleEdit(agent)}>
                <EditSvg />
              </button> */}
              <button
                className="agent-action-btn danger"
                title={t('删除')}
                onClick={() => handleDelete(agent)}>
                {t('删除')}
              </button>
            </div>
          </div>
        ))}

        {agents.length === 0 && (
          <div className="agent-empty">
            <p>{t('暂无 Agent，点击上方按钮创建')}</p>
          </div>
        )}
      </div>

      <AgentEditModal
        visible={showModal}
        agent={editingAgent}
        onClose={() => {
          setShowModal(false)
          setEditingAgent(null)
        }}
        onSave={handleSave}
      />
    </div>
  )
}

export default observer(AgentSettings)
