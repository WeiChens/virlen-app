/**
 * security-permissions — 安全菜单 · 权限管理 Tab
 *
 * 以列表展示每种操作的三态权限（允许 / 每次弹窗授权 / 禁止），右侧下拉切换。
 * 权限 name、默认值与决策逻辑见 `@/domain/permission`（与 Rust 侧逐字对齐）。
 */
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { PERMISSIONS, type PermissionDecision } from '@/domain/permission'
import Select from '@/ui/components/shared/Select'
import { t } from '@/ui/i18n'

function SecurityPermissions() {
  const permissions = settingsState.value.permissions

  // 三态顺序固定为「宽松 → 严格」（允许 / 询问 / 禁止）：下拉里也是这个顺序，
  // 换控件不换语义。label 用短文案压控件宽度，完整含义由说明文字 + 选项 title 承载
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
      <div className="permission-list">
        {PERMISSIONS.map((perm) => {
          const value = permissions[perm.name] ?? perm.default
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
              <Select
                className={`perm-select is-${value}`}
                value={value}
                onChange={(next) => setDecision(perm.name, next as PermissionDecision)}
                options={DECISION_OPTIONS}
                ariaLabel={t(perm.label)}
                width={96}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default observer(SecurityPermissions)
