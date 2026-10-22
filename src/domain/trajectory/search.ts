/**
 * 轨迹内的搜索（纯前端过滤）。
 *
 * 只匹配「表格上看得见 / 检查器里能展开」的字段：摘要、工具名与参数、工具结果、正文与思考。
 * 不查数据库 —— 轨迹视图只看已加载的那段历史，用 FTS5 反而会把未加载的更早消息也翻出来，
 * 点进去却滚不到（那条记录根本不在表里）。
 */
import type { TrajectoryTurn } from './types'
import { argumentsBrief, contentText } from './text'

/** 一条记录参与匹配的全部文本（大小写不敏感） */
function searchableOf(
  record: TrajectoryTurn['groups'][number]['records'][number],
): string {
  const parts = [record.text, record.resultText ?? '', record.toolName ?? '']
  if (record.toolCall) parts.push(argumentsBrief(record.toolCall.input, 2000))
  if (record.message) {
    parts.push(contentText(record.message.content))
    if (record.message.reasoningContent) parts.push(record.message.reasoningContent)
  }
  if (record.result?.message) parts.push(contentText(record.result.message.content))
  if (record.systemPrompt) parts.push(record.systemPrompt)
  return parts.join('\n').toLowerCase()
}

/**
 * 找出匹配关键词的记录行号。
 * @param turns 轨迹
 * @param query 关键词（空串 / 全空白 → `null`，表示「没有过滤」）
 * @returns 命中的行号集合；无关键词时为 `null`
 */
export function searchRecords(
  turns: readonly TrajectoryTurn[],
  query: string,
): ReadonlySet<number> | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const hits = new Set<number>()
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (searchableOf(record).includes(needle)) hits.add(record.index)
      }
    }
  }
  return hits
}
