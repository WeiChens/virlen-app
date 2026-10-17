/**
 * 文档删除：单份与「清空」两条路径。删一份不是瞬完成（后端要清向量库片段），故行内给「删除中…」；
 * 清空逐份删、走 `TaskProgress` 可取消进度弹窗，取消只在整份边界生效。
 * 记忆详情正文由后端拒删（入口在记忆那边）。
 */
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { beginTask } from '@/ui/components/shared/TaskProgress'
import type { KnowledgeBaseDocument } from '@/domain/ports'

/** 删除的成败计数 */
export interface DeleteCounts {
  /** 真的删掉的份数 */
  success: number
  /** 请求失败、没删掉的份数 */
  failed: number
}

/** 把删除计数拼成一句用户能读的话（进度弹窗的实时统计与结束汇总共用） */
export function summarizeDelete(counts: DeleteCounts): string {
  const parts = [tpl('已删除 $__count__ 份', { count: counts.success })]
  if (counts.failed > 0)
    parts.push(tpl('$__count__ 份没删掉', { count: counts.failed }))
  return parts.join('，')
}

/**
 * 删单份第一步：只弹确认框。拆两步是为了「删除中…」在用户确认之后才出现 ——
 * 确认框还弹着时按钮就变，用户又点了取消，那一幕是骗人的。
 */
export async function confirmRemoveDocument(docName: string): Promise<boolean> {
  return (
    (await MessageBox.propt(
      t('删除文档'),
      tpl('删除「$__name__」后，AI 就查不到它的内容了。', { name: docName }),
      { danger: true, confirmText: t('删除') },
    )) === true
  )
}

/**
 * 删单份第二步：真删 + toast。@returns 是否真删掉（没删成时刷新没意义）。
 * ⚠️ 调用方需先在按钮上切「删除中…」：后端要清向量库片段，不是瞬返回。
 */
export async function removeDocumentNow(
  kbId: string,
  docId: string,
): Promise<boolean> {
  try {
    await ragService.removeDocument(kbId, docId)
    showToast(t('文档已删除'))
    return true
  } catch (err: any) {
    showToast(tpl('删除失败：$__error__', { error: err?.message || err }), 3000)
    return false
  }
}

/**
 * 清空文档：逐份删，全程一个可取消的进度弹窗。
 * @returns 是否真的动过手（一份都没轮到：全被锁 / 用户取消 / 拒绝确认 → false，调用方不必刷新）
 */
export async function clearAllDocuments(
  kbId: string,
  kbName: string,
  docs: KnowledgeBaseDocument[],
): Promise<boolean> {
  if (!kbId || docs.length === 0) return false

  // 记忆详情正文删不掉（后端也会拒）：提前摘出去，并在确认框里说清「不是全部都会删」。
  // 用户点「全部删除」是想清空，不该事后才发现还剩几份没说清来历的文档。
  const removable = docs.filter((d) => !d.memory_detail_of)
  const lockedCount = docs.length - removable.length
  if (removable.length === 0) {
    showToast(t('这里的文档都是记忆的详情正文，不能在这个列表里删'), 3000)
    return false
  }

  const confirmed = await MessageBox.propt(
    t('清空文档'),
    tpl('「$__name__」里的 $__count__ 份文档会被全部删除，无法恢复。', {
      name: kbName,
      count: removable.length,
    }) +
      (lockedCount > 0
        ? '\n' +
          tpl('另外 $__count__ 份是记忆的详情正文，会跳过（删记忆时才会一起清）', {
            count: lockedCount,
          })
        : ''),
    { danger: true, confirmText: t('全部删除') },
  )
  if (!confirmed) return false

  const counts: DeleteCounts = { success: 0, failed: 0 }
  const task = beginTask({
    title: t('正在删除文档'),
    source: tpl('「$__name__」· 共 $__count__ 份', {
      name: kbName,
      count: removable.length,
    }),
    total: removable.length,
    doneText: t('删除完成'),
    stoppedText: t('已停止删除'),
    stoppingHint: t('正在停下 —— 这一份删完就不删了，已经删掉的收不回来'),
    ariaLabel: t('删除进度'),
  })

  let index = 0
  for (const doc of removable) {
    // 用户取消：停在**整份的边界**上（每一份要么整个删掉，要么还完整留着）
    if (task.cancelled) break
    index++
    task.step(
      index,
      tpl('正在删除「$__name__」', { name: doc.file_name }),
      summarizeDelete(counts),
    )
    try {
      await ragService.removeDocument(kbId, doc.id)
      counts.success++
    } catch {
      // 单份失败不打断整批：剩下那些还是要删的（失败份数在汇总里交代）
      counts.failed++
    }
  }

  // 收尾交给弹窗（标题换成「删除完成 / 已停止删除」，最新文案换成汇总）；
  // 与导入不同，这里**不再补一条 toast**：结果就写在弹窗上，用户关掉前一定看得到。
  task.finish(task.cancelled, summarizeDelete(counts))
  return counts.success + counts.failed > 0
}
