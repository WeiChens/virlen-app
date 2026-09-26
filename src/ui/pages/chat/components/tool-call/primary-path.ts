/**
 * primary-path — 从工具入参里取「主路径」
 *
 * 用途：工具调用卡片（read_file / write_file / edit_file / mkdir …）右键时
 * 要弹「打开 / 在文件管理器中显示 / 复制路径」菜单，而卡片上显示的是**短路径**
 * （`toShortPath` 相对工作目录），必须回到入参才能拿到可直接交给系统的绝对路径。
 *
 * 为什么用「按键名取」而不是给每个工具加方法：路径类入参的键名在各工具定义里
 * 已经统一（见 infrastructure/tools/file|search|vision），键名清单是稳定契约；
 * 反过来给十来个工具各加一个 `getPrimaryPath()` 只会把同一件事抄十遍。
 *
 * 拿不到就返回 undefined（调用方据此决定不开菜单），不要猜。
 */

/** 单个字符串型路径键（按优先级：主操作对象 > 目标） */
const SINGLE_PATH_KEYS = ['path', 'file_path', 'source', 'destination'] as const

/** 数组型路径键（read_file / mkdir / delete_file 支持批量） */
const ARRAY_PATH_KEYS = ['paths', 'file_paths'] as const

/** 从工具入参里取主路径；取不到返回 undefined */
export function primaryPathOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>

  for (const key of SINGLE_PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }

  for (const key of ARRAY_PATH_KEYS) {
    const value = record[key]
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === 'string' && v.trim())
      if (typeof first === 'string') return first
    }
  }

  return undefined
}
