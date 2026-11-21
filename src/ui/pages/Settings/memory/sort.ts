/**
 * sort — 记忆列表的排序（纯函数，便于单测）
 *
 * 只在**界面上**排：后端列表自带顺序（永久在前 → 新建在前），`default` 就是原样不动。
 * 用户选了「记录时间」就想要纯时间序 —— 那时不再让永久记忆顶到最前：两种心思混在一个
 * 结果里，用户看不出自己选的到底是什么。
 *
 * ⚠️ 不就地排：`items` 是父级持有的数组（props），排序必须复制一份再排。
 */

import type { MemoryRecord } from '@/domain/memory'

/** 「不排序」= 沿用后端顺序（永久在前 → 新建在前） */
export const SORT_DEFAULT = 'default'

/** 排序方式：字段 + 方向合成一个取值（下拉一次选完，不留「换了字段、方向还是上次的」这种隐含状态） */
export type MemoryListSort =
  | typeof SORT_DEFAULT
  | 'created-desc'
  | 'created-asc'
  | 'hits-desc'
  | 'hits-asc'

/**
 * 按 `sort` 排一份新数组；`SORT_DEFAULT` 原样返回（同一个引用，调用方不必判断是否变了）。
 */
export function sortMemories(
  items: MemoryRecord[],
  sort: MemoryListSort,
): MemoryRecord[] {
  if (sort === SORT_DEFAULT) return items
  const sign = sort.endsWith('-desc') ? -1 : 1
  const byCreated = sort.startsWith('created')
  return [...items].sort((a, b) => {
    if (!byCreated) return ((a.hits ?? 0) - (b.hits ?? 0)) * sign
    const ca = a.createdAt ?? 0
    const cb = b.createdAt ?? 0
    // 没有记录日期（缺失 / 0）的**永远排最后**：让 0 参与升序会把它顶到第一行，看着像排错了
    if (ca === 0 || cb === 0) {
      if (ca === cb) return 0
      return ca === 0 ? 1 : -1
    }
    return (ca - cb) * sign
  })
}
