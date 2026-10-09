/**
 * 文档删除 —— 单份删除与「清空文档」两条路径
 *
 * 两件事都和「时间」有关，也是这个文件存在的理由：
 * - **删一份不是瞬间完成的**（后端要把这份文档在向量库里的片段一起清掉，再回写元数据）。
 *   从前点了「删除」到列表刷新之间界面毫无变化，用户以为没点上、于是再点一次 ——
 *   行内的「删除中…」就是给这段等待一个交代（`DocListModal` 用 `deletingId` 画）；
 * - **清空是逐份删的**，几十份要花上几秒到十几秒。所以它走 `shared/TaskProgress` 那个
 *   批量进度弹窗：逐份显示「正在删除 xxx」，随时可取消，结束时给一句汇总 ——
 *   口径与导入一致（取消在**整份的边界**上生效，不会删到一半）。
 *
 * 记忆详情正文（`memory_detail_of`）不在这里删：后端会拒，入口在记忆那边（删记忆时才一起清）。
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
 * 删单份的第一步：只弹确认框。
 *
 * 为什么拆成两步（确认 / 真删）：「删除中…」应该在**用户确认之后**才出现 ——
 * 确认框还弹着的时候按钮就变「删除中…」，用户又点了取消，那一幕是骗人的。
 * 所以调用方拿到 true 之后再切按钮、再调 [`removeDocumentNow`]。
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
 * 删单份的第二步：真的删掉 + 一句 toast。
 *
 * @returns 是否真的删掉了 —— 调用方据此决定要不要刷新列表（没删成时刷新没有意义）。
 *          ⚠️ 调用方要先在按钮上切「删除中…」：这一句要等后端把这份文档在向量库里的
 *          片段一起清掉，不是瞬返回。
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
 * 清空知识库里的文档 —— 逐份删，全程一个可取消的进度弹窗。
 *
 * @param kbName 库名（确认框与进度弹窗里都要说清「清的是哪个库」）
 * @param docs   当前列表里的文档（调用方已经加载过，不再多查一次）
 * @returns      是否真的动过手（有一份被删掉了 / 试过但失败了）——
 *               一份都没轮到（被全部锁定、用户取消、直接拒绝确认）时返回 false，调用方不必刷新
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
