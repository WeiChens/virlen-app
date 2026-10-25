/**
 * 轨迹视图的文案拼装（唯一一处把 domain 的结构化标题落成界面文字）。
 *
 * domain 层只给「第几步 / 压缩第几段 / 空内容的原因」这类结构，文案在这里决定 ——
 * 换语言只改 en-US.json，不用回头动投影逻辑。
 */
import type {
  TrajectoryEmptyReason,
  TrajectoryGroupTitle,
  TrajectoryKind,
  TrajectoryRecord,
  TrajectoryTurnTitle,
} from '@/domain/trajectory'
import { t, tpl } from '@/ui/i18n'

/** 轮头标题：`会话开始` / `第 N 轮` / `压缩 N` */
export function turnTitle(title: TrajectoryTurnTitle): string {
  switch (title.kind) {
    case 'start':
      return t('对话开始')
    case 'turn':
      return tpl('第 $__turn__ 轮', { turn: title.turn })
    case 'compaction':
      return tpl('压缩 $__index__', { index: title.index })
  }
}

/** 组头标题：`消息` / `第 N 步` / `压缩` */
export function groupTitle(title: TrajectoryGroupTitle): string {
  switch (title.kind) {
    case 'message':
      return t('消息')
    case 'step':
      return tpl('第 $__step__ 步', { step: title.step })
    case 'compaction':
      return t('压缩')
  }
}

/** 行类型标签 */
export function kindLabel(kind: TrajectoryKind): string {
  switch (kind) {
    case 'system':
      return t('系统')
    case 'user':
      return t('用户')
    case 'context':
      return t('上下文')
    case 'message':
      return t('回复')
    case 'tool':
      return t('工具')
    case 'compacted':
      return t('压缩')
  }
}

/** 空内容占位文案 */
function emptyText(reason: TrajectoryEmptyReason | undefined): string {
  return reason === 'toolCallOnly' ? t('（仅工具调用）') : t('（无内容）')
}

/** 附件计数（`图片 2 · 文件 1`），没有附件返回空串 */
export function attachmentLabel(record: TrajectoryRecord): string {
  const counts = record.attachments
  if (!counts) return ''
  const parts: string[] = []
  if (counts.images > 0) parts.push(tpl('图片 $__n__', { n: counts.images }))
  if (counts.files > 0) parts.push(tpl('文件 $__n__', { n: counts.files }))
  if (counts.quotes > 0) parts.push(tpl('引用 $__n__', { n: counts.quotes }))
  if (counts.skills > 0) parts.push(tpl('技能 $__n__', { n: counts.skills }))
  return parts.join(' · ')
}

/**
 * 记录行的主文本（工具行的「参数」段在 `record.argsText` 里单独渲染）。
 *
 * 顺序很重要：先看 kind（压缩行即使正文为空也要说「已压缩」，而不是「无内容」），
 * 再看正文，最后才落到空内容占位。
 */
export function recordText(record: TrajectoryRecord): string {
  switch (record.kind) {
    case 'system': {
      const chars = record.systemPrompt?.length ?? 0
      return tpl('系统提示词 · $__n__ 字符', { n: chars })
    }
    case 'compacted': {
      if (record.text) return record.text
      if (record.contextTokens !== undefined) {
        return tpl('已压缩 · 上下文 $__n__ tok', { n: record.contextTokens })
      }
      return t('已压缩')
    }
    case 'context': {
      if (record.noteKind === 'todo') return t('任务清单已更新')
      if (record.noteKind === 'service') {
        return tpl('后台服务「$__name__」已结束', { name: record.noteName ?? '' })
      }
      return record.text || t('上下文注入')
    }
    case 'tool':
      return record.text || t('工具调用')
    default:
      return record.text || emptyText(record.emptyReason)
  }
}

/** 工具行的结果段文案（`执行中` / `无输出` 兜底） */
export function toolResultText(record: TrajectoryRecord): string {
  if (record.resultText) return record.resultText
  if (record.running) return t('执行中…')
  if (record.kind === 'tool' && record.result) return t('（无输出）')
  return ''
}
