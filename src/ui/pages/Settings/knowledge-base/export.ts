/**
 * 知识库压缩包 —— 导出（整库打成 ZIP）与导入（ZIP 里的文档读回来）
 *
 * ⚠️ 导出的是**解析后的纯文本**，不是原始文件：知识库里存的就是文本块，原始 PDF 早就不在了。
 * 所以导入也按纯文本入库（名字沿用条目名），与导出成对。
 */
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { showToast } from '@/ui/components/shared/Toast'
import { beginTask } from '@/ui/components/shared/TaskProgress'
import {
  confirmOverwrite,
  importZipEntries,
  MAX_TEXT_FILE_BYTES,
  mbOf,
  summarizeImport,
} from './file-import'

/** 导出知识库为 ZIP（指定 kbId 和 kbName，供卡片 / 文档列表弹窗共用） */
export async function exportKnowledgeBaseZip(kbId: string, kbName: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const savePath = await save({
      defaultPath: `${kbName}.zip`,
      filters: [
        {
          name: t('压缩包'),
          extensions: ['zip'],
        },
      ],
    })
    if (!savePath) return

    showToast(tpl('正在打包「$__name__」…', { name: kbName }))
    await ragService.exportKnowledgeBase(kbId, savePath)
    showToast(tpl('已导出到 $__path__', { path: savePath }))
  } catch (err: any) {
    showToast(tpl('导出失败：$__error__', { error: err.message }), 3000)
  }
}

/**
 * 导入压缩包（导出的逆操作），返回「是否有文档真的进来了」，调用方据此决定要不要刷新列表。
 *
 * 两步走，都为了「不做盲操作」：
 * 1. 先读一遍条目名（只读 ZIP 中央目录，不解压内容）—— 用户选的是一个文件，看不到里面有什么；
 *    不说清哪几份会被覆盖，「覆盖」就是一次赌博；
 * 2. 再逐条读 + 逐条入库（[`importZipEntries`]）—— 全程有进度、可取消，
 *    而不是「点了之后等十秒，不知道在干什么」。
 *
 * 包里的条目按纯文本入库（导出写的就是文本），所以这里也只有 `.gitignore` 与 2 MB 上限两条口径。
 */
export async function importKnowledgeBaseZip(
  kbId: string,
  kbName: string,
  existing: Map<string, string>,
): Promise<boolean> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: false,
      filters: [{ name: t('压缩包'), extensions: ['zip'] }],
    })
    if (!selected) return false
    const zipPath = selected as string

    showToast(t('正在看压缩包里有哪些文档…'))
    let preview
    try {
      preview = await ragService.previewKnowledgeBaseZip(zipPath)
    } catch (err: any) {
      showToast(tpl('读不了这个压缩包：$__error__', { error: err.message }), 3000)
      return false
    }
    if (preview.names.length === 0) {
      // 两种「空」分开说：被 .gitignore 排除的（用户自己的规则）与超过 2 MB 的（大小限制）
      const notes: string[] = []
      if (preview.ignored > 0)
        notes.push(
          tpl('$__count__ 份被 .gitignore 排除，已跳过', { count: preview.ignored }),
        )
      if (preview.too_large > 0)
        notes.push(
          tpl('$__count__ 份超过 $__limit__ MB，已跳过', {
            count: preview.too_large,
            limit: mbOf(MAX_TEXT_FILE_BYTES),
          }),
        )
      showToast(
        notes.length > 0
          ? tpl('这个压缩包里没有能导入的内容：$__notes__', {
              notes: notes.join('，'),
            })
          : t('这个压缩包里没有文档'),
        3000,
      )
      return false
    }

    const dup = preview.names.filter((n) => existing.has(n))
    const overwrite = await confirmOverwrite(dup)

    const task = beginTask({
      title: t('正在导入压缩包'),
      source: tpl('「$__name__」· 从压缩包 $__file__', {
        name: kbName,
        file: zipPath.replace(/\\/g, '/').split('/').pop() || zipPath,
      }),
      total: preview.names.length,
      doneText: t('导入完成'),
      stoppedText: t('已停止导入'),
      stoppingHint: t(
        '正在停下 —— 这一份处理完就收手，已经进来的文档不会回退',
      ),
      ariaLabel: t('导入进度'),
    })
    if (preview.ignored > 0 || preview.too_large > 0) {
      // 先说一句「排掉了多少、为什么」（下一份处理时会被替换成新的最新文案）
      const notes: string[] = []
      if (preview.ignored > 0)
        notes.push(
          tpl('$__count__ 份被 .gitignore 排除，已跳过', { count: preview.ignored }),
        )
      if (preview.too_large > 0)
        notes.push(
          tpl('$__count__ 份超过 $__limit__ MB，已跳过', {
            count: preview.too_large,
            limit: mbOf(MAX_TEXT_FILE_BYTES),
          }),
        )
      task.step(0, notes.join('\n'), '')
    }

    let counts
    try {
      counts = await importZipEntries(
        kbId,
        zipPath,
        preview.names,
        { existing, overwrite },
        undefined,
        task,
      )
    } catch (err: any) {
      // 兜底：不该发生（逐条读 / 写都各自兜错），但弹窗不能卡在「运行中」
      showToast(tpl('导入没能完成：$__error__', { error: err?.message || err }), 3000)
      task.finish(true, t('导入没能完成'))
      return false
    }
    if (counts.failed > 0 && counts.created + counts.overwritten === 0) {
      // 一份都没进来时，除了弹窗里的汇总，再单独说一句（弹窗关掉后还能看到）
      showToast(
        tpl('导入压缩包失败：$__summary__', {
          summary: summarizeImport(counts),
        }),
        3000,
      )
    }
    return counts.created + counts.overwritten > 0
  } catch (err: any) {
    showToast(tpl('导入失败：$__error__', { error: err.message }), 3000)
    return false
  }
}
