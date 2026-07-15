/**
 * quickinput-settings — 快捷输入设置页面
 *
 * 用户可以在此处管理快捷输入模板列表（增删改）。
 */
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import type { QuickInputTemplate } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import AddSvg from '@/ui/components/icons/AddSvg'
import { t } from '@/ui/i18n'
import './quickinput-settings.scss'

function QuickInputSettings() {
  const templates = settingsState.value.quickInputTemplates

  const updateTemplates = (newTemplates: QuickInputTemplate[]) => {
    settingsState.setValue('quickInputTemplates', newTemplates)
  }

  /** 添加新模板 */
  const handleAdd = () => {
    const newTemplate: QuickInputTemplate = {
      id: v4(),
      text: '',
    }
    updateTemplates([...templates, newTemplate])
  }

  /** 更新模板文本 */
  const handleUpdate = (id: string, value: string) => {
    const updated = templates.map((t) =>
      t.id === id ? { ...t, text: value } : t,
    )
    updateTemplates(updated)
  }

  /** 删除模板 */
  const handleDelete = (id: string) => {
    const updated = templates.filter((t) => t.id !== id)
    updateTemplates(updated)
  }

  return (
    <div className="quickinput-settings">
      <h2 className="section-title">{t('快捷输入')}</h2>
      <p className="section-desc">
        {t('添加快捷输入模板，在聊天输入框底部点击按钮即可快速填入预设文本。')}
        {t('输入一段文本作为模板内容，点击即可填入输入框。')}
      </p>

      {templates.length === 0 ? (
        <div className="empty-hint">
          {t('暂无快捷输入模板')}
          <br />
          {t('点击下方按钮添加')}
        </div>
      ) : (
        <div className="template-list">
          {templates.map((template) => (
            <div key={template.id} className="template-item">
              <div className="template-fields">
                <input
                  className="template-text-input"
                  type="text"
                  placeholder={t('例如：看看今天的新闻')}
                  value={template.text}
                  onChange={(e) => handleUpdate(template.id, e.target.value)}
                  maxLength={50}
                  autoComplete="off"
                />
                {/* <span className="template-char-count">{template.text.length}/50</span> */}
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
        <span>{t('添加快捷输入模板')}</span>
      </button>
    </div>
  )
}

export default observer(QuickInputSettings)
