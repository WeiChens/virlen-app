/**
 * 会话工具白名单过滤（纯函数）—— **唯一口径**。
 *
 * 三态语义直接决定「模型能不能看到这个工具」，任何一处写错都会让界面与真实下发分叉：
 * - `undefined`：会话没有白名单（老数据 / 默认 Agent）→ **全部**工具
 * - `[]`：显式关掉全部工具 → **一个都不给**
 * - `[names]`：只给名单里的（顺序仍以契约顺序为准，白名单不参与排序）
 *
 * ⚠️ 引擎侧（`services/rust-engine.ts::resolveToolDefs`）与轨迹检查器的工具目录
 * 必须共用本实现：否则「轨迹里说发了 N 个工具」与「实际发给模型 N' 个」会各说各话。
 */
export function filterAllowedToolDefs<T extends { name: string }>(
  defs: readonly T[],
  allowed: readonly string[] | undefined,
): T[] {
  if (allowed === undefined) return [...defs]
  if (allowed.length === 0) return []
  const names = new Set(allowed)
  return defs.filter((def) => names.has(def.name))
}
