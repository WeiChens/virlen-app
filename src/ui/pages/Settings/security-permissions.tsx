/**
 * security-permissions — 安全菜单 · 权限管理 Tab
 *
 * 以列表展示每种操作的三态权限（允许 / 每次弹窗授权 / 禁止），用三段滑块切换。
 * 权限 name、默认值与决策逻辑见 `@/domain/permission`（与 Rust 侧逐字对齐）。
 */
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { PERMISSIONS, type PermissionDecision } from '@/domain/permission'
import { t } from '@/ui/i18n'

function SecurityPermissions() {
  const permissions = settingsState.value.permissions

  // 三态滑块顺序固定：索引 × translateX 档位与滑块的 translate 一一对应。
  // 段内用短文案以压缩控件宽度，完整含义由说明文字 + 按钮 title 提示承载
  const DECISION_OPTIONS: {
    value: PermissionDecision
    label: string
    title?: string
  }[] = [
    { value: 'allow', label: t('允许') },
    { value: 'ask', label: t('询问'), title: t('每次弹窗授权') },
    { value: 'deny', label: t('禁止') },
  ]

  function setDecision(name: string, decision: PermissionDecision) {
    // permissions 是深层 observable：写新对象引用触发持久化 + settings.change 埋点
    settingsState.setValue('permissions', { ...permissions, [name]: decision })
  }

  return (
    <div className="permissions-panel">
      <div className="section-desc">
        {t('为每种操作单独设置权限：允许直接执行 / 每次弹窗授权 / 禁止执行')}
      </div>
      <div className="permission-list">
        {PERMISSIONS.map((perm) => {
          const value = permissions[perm.name] ?? perm.default
          const index = Math.max(
            0,
            DECISION_OPTIONS.findIndex((o) => o.value === value),
          )
          return (
            <div className="permission-item" key={perm.name}>
              <div className="permission-info">
                <div className="permission-head">
                  <span className="permission-title">{t(perm.label)}</span>
                  <code className="perm-name" title={perm.name}>
                    {perm.name}
                  </code>
                </div>
                <p className="permission-desc">{t(perm.description)}</p>
              </div>
              <div
                className={`tri-switch tri-${value}`}
                role="radiogroup"
                aria-label={t(perm.label)}>
                <span
                  className="tri-thumb"
                  aria-hidden="true"
                  style={{ transform: `translateX(${index * 100}%)` }}
                />
                {DECISION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={value === opt.value}
                    className={`tri-seg${value === opt.value ? ' active' : ''}`}
                    title={opt.title}
                    onClick={() => setDecision(perm.name, opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default observer(SecurityPermissions)
