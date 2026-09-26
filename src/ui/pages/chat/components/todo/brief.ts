/**
 * todo/brief — 任务清单变更摘要（**界面文案**，走 i18n）
 *
 * 与 `domain/todo/state::renderChangeBrief` 的区别：
 * 那一份是拼给**模型**看的中文摘要（domain 层不允许依赖 i18n），
 * 这一份是给界面用的，必须走 `t` / `tpl`（铁律 7：业务文案走 i18n）。
 */
import { t, tpl } from '@/ui/i18n'
import type { TodoChange, TodoStatus } from '@/domain/todo/types'

/** 状态枚举 → 界面标签 */
export function statusLabel(status: TodoStatus): string {
  if (status === 'completed') return t('已完成')
  if (status === 'in_progress') return t('进行中')
  return t('待办')
}

/** 变更列表 → 一行摘要（如「移除「补充单测」· 「写工具」→ 已完成」） */
export function changeBrief(changes: TodoChange[] | undefined): string {
  if (!changes || changes.length === 0) return t('已更新')
  return changes
    .map((c) => {
      switch (c.type) {
        case 'add':
          return tpl('新增「$__name__」', { name: c.content })
        case 'remove':
          return tpl('移除「$__name__」', { name: c.content })
        case 'status':
          return tpl('「$__name__」→ $__status__', {
            name: c.content,
            // toStatus 是枚举（可 i18n）；to 是中文标签（给模型的那份）
            status: c.toStatus ? statusLabel(c.toStatus) : c.to,
          })
        case 'edit':
          return tpl('改写为「$__name__」', { name: c.to })
        case 'note':
          return tpl('「$__name__」备注已更新', { name: c.content })
        case 'reorder':
          return t('调整顺序')
        default:
          return t('已更新')
      }
    })
    .join(' · ')
}
