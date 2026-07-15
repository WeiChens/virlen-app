/**
 * agent-selector — Agent 选择器下拉
 * 仅当没有活跃会话时显示，用于选择默认 Agent
 */
import { useState, useRef, useEffect } from 'react'
import { chatState, agentStore, settingsState } from '@/ui/store'
import AgentSvg from '@/ui/components/icons/AgentSvg'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import { getDefaultAgent } from '@/services/agent-service'
import { t } from '@/ui/i18n'
import { Agent } from '@/types'

interface Props {
  sessionId?: string
}
let defaultAgent: Agent | null = null
function getOrInitDefaultAgent(): Agent {
  if (!defaultAgent) defaultAgent = getDefaultAgent()
  return defaultAgent
}

export default function AgentSelector({ sessionId }: Props) {
  const [agentOpen, setAgentOpen] = useState(false)
  const agentRef = useRef<HTMLDivElement>(null)
  const agents = agentStore.listAgents()
  const currentAgentId = !sessionId ? chatState.value.selectedAgentId : ''
  const currentAgent =
    agentStore.getAgent(currentAgentId) || getOrInitDefaultAgent()

  // 外部点击关闭
  useEffect(() => {
    if (!agentOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (agentRef.current && !agentRef.current.contains(e.target as Node)) {
        setAgentOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [agentOpen])

  function handleSelectAgent(agentId: string) {
    const agent = agentStore.getAgent(agentId)
    if (agent) {
      chatState.setValue('selectedAgentId', agentId)
      // 将 Agent 的模型和工作目录复制到 chat-view 状态
      if (agent.defaultModel?.providerConfigId && agent.defaultModel?.modelId) {
        chatState.setValue('selectModel', {
          providerConfigId: agent.defaultModel?.providerConfigId,
          modelId: agent.defaultModel?.modelId,
        })
      }
      chatState.setValue(
        'selectedWorkspace',
        agent.defaultWorkspace || settingsState.value.defaultWorkspace,
      )
    }
    setAgentOpen(false)
  }

  if (agents.length < 1) return null

  return (
    <div className="agent-switcher" ref={agentRef}>
      <button
        className={`agent-switcher-trigger ${agentOpen ? 'open' : ''}`}
        onClick={() => setAgentOpen(!agentOpen)}
        title={t('切换 Agent')}>
        <AgentSvg />
        <span className="trigger-agent-name">
          {currentAgent?.name || t('默认 Agent')}
        </span>
        <DropDownSvg className="trigger-arrow" />
      </button>
      {agentOpen && (
        <div className="agent-dropdown">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={`agent-dropdown-item ${agent.id === currentAgentId ? 'active' : ''}`}
              onClick={() => handleSelectAgent(agent.id)}>
              <span className="agent-name">{agent.name}</span>
              {agent.description && (
                <span className="agent-desc">{agent.description}</span>
              )}
              {agent.id === currentAgentId && (
                <span className="check-mark">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
