/**
 * labels — 记忆「分类 / 级别」的展示文案与下拉选项
 *
 * 抽一份的原因：表格列值、筛选栏下拉、编辑弹窗下拉**必须同一套中文名**，各写一份迟早分叉
 *（表格显示「决策」而下拉里叫「决定」）。
 *
 * ⚠️ 文案一律**调用时**取 `t()`，不预先算成模块级常量 —— 常量在 `initI18n()` 之前就被求值，会
 * 永久冻在中文（英文环境下分类列仍是中文，且只在切语言后才发现）。
 * ⚠️ `value` 永远是存储用的英文枚举（`user` / `project` / …），中文只出现在展示层。
 */
import { t } from '@/ui/i18n'
import { MEMORY_KINDS, type MemoryKind } from '@/domain/memory'
import type { SelectOption } from '@/ui/components/shared/Select'

/** 分类 → 中文文案（同时也是 i18n key） */
const KIND_KEYS: Record<MemoryKind, string> = {
  user: '用户偏好',
  project: '项目',
  decision: '决策',
  fact: '事实',
}

/** 筛选栏用的「不筛」值（只活在 UI 里，不会写进库） */
export const FILTER_ALL = 'all'

/**
 * 分类下拉选项。
 * @param withAll 带一条「全部」（筛选栏用）—— 编辑表单**不能**带：`all` 不是合法存储值，
 *                真让用户选到就会往库里写一个不存在的分类。
 */
export function kindOptions(withAll = false): SelectOption[] {
  const opts: SelectOption[] = MEMORY_KINDS.map((k) => ({ value: k, label: t(KIND_KEYS[k]) }))
  return withAll ? [{ value: FILTER_ALL, label: t('全部') }, ...opts] : opts
}

/** 级别下拉选项（普通 / 永久 = 注入策略，别用「低 / 高」这类含糊说法）。`withAll` 同上。 */
export function levelOptions(withAll = false): SelectOption[] {
  const opts: SelectOption[] = [
    { value: 'normal', label: t('普通') },
    { value: 'permanent', label: t('永久') },
  ]
  return withAll ? [{ value: FILTER_ALL, label: t('全部') }, ...opts] : opts
}

/** 分类的展示名（库里有脏值时原样显示，不吞掉 —— 要能看见） */
export function kindLabel(kind: string): string {
  const key = KIND_KEYS[kind as MemoryKind]
  return key ? t(key) : kind
}

/** 级别的展示名 */
export function levelLabel(level: string): string {
  return level === 'permanent' ? t('永久') : t('普通')
}
