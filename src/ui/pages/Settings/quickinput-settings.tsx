/**
 * quickinput-settings — 快捷输入设置页面
 *
 * 两个 tab：
 * - 常规快捷输入：填入聊天输入框的预设文本
 * - 验证目标快捷输入：填入迭代模式 Goal 的预设目标
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import type { QuickInputTemplate } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import AddSvg from '@/ui/components/icons/AddSvg'
import { t } from '@/ui/i18n'
import './quickinput-settings.scss'

type QuickInputTab = 'normal' | 'goal'

function QuickInputSettings() {
  const [activeTab, setActiveTab] = useState<QuickInputTab>('normal')

  const templates = settingsState.value.quickInputTemplates
  const goalTemplates = settingsState.value.goalQuickInputTemplates

  const isGoal = activeTab === 'goal'
  const currentList = isGoal ? goalTemplates : templates

  /** 更新当前 tab 的模板列表 */
  const updateTemplates = (newTemplates: QuickInputTemplate[]) => {
    settingsState.setValue(
      isGoal ? 'goalQuickInputTemplates' : 'quickInputTemplates',
      newTemplates,
    )
  }

  /** 添加新模板 */
  const handleAdd = () => {
    const newTemplate: QuickInputTemplate = {
      id: v4(),
      text: '',
    }
    updateTemplates([...currentList, newTemplate])
  }

  /** 更新模板文本 */
  const handleUpdate = (id: string, value: string) => {
    const updated = currentList.map((t) =>
      t.id === id ? { ...t, text: value } : t,
    )
    updateTemplates(updated)
  }

  /** 删除模板 */
  const handleDelete = (id: string) => {
    const updated = currentList.filter((t) => t.id !== id)
    updateTemplates(updated)
  }

  return (
    <div className="quickinput-settings">
      <h2 className="section-title">{t('快捷输入')}</h2>

      {/* Tab 切换 */}
      <div className="quickinput-tabs">
        <button
          className={`quickinput-tab ${!isGoal ? 'active' : ''}`}
          onClick={() => setActiveTab('normal')}
          type="button">
          {t('常规快捷输入')}
        </button>
        <button
          className={`quickinput-tab ${isGoal ? 'active' : ''}`}
          onClick={() => setActiveTab('goal')}
          type="button">
          🎯 {t('验证目标快捷输入')}
        </button>
      </div>

      <p className="section-desc">
        {isGoal
          ? t(
              '添加验证目标模板，点击后自动填入迭代模式的 Goal 输入框，AI 会执行→验证→修复直到达标。',
            )
          : t(
              '添加快捷输入模板，在聊天输入框底部点击按钮即可快速填入预设文本。',
            )}
      </p>

      {currentList.length === 0 ? (
        <div className="empty-hint">
          {t('暂无快捷输入模板')}
          <br />
          {t('点击下方按钮添加')}
        </div>
      ) : (
        <div className="template-list">
          {currentList.map((template) => (
            <div key={template.id} className="template-item">
              <div className="template-fields">
                <input
                  className="template-text-input"
                  type="text"
                  placeholder={
                    isGoal
                      ? t('例如：创建 src/components/Login.tsx 并测试可编译')
                      : t('例如：看看今天的新闻')
                  }
                  value={template.text}
                  onChange={(e) => handleUpdate(template.id, e.target.value)}
                  maxLength={100}
                  autoComplete="off"
                />
              </div>
              <div className="template-actions">
                <button
                  className="template-delete-btn"
                  onClick={() => handleDelete(template.id)}
                  title={t('删除模板')}
                  type="button">
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button className="add-template-btn" onClick={handleAdd} type="button">
        <AddSvg />
        <span>{t('添加模板')}</span>
      </button>
    </div>
  )
}

export default observer(QuickInputSettings)
