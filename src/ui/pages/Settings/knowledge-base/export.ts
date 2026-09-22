/**
 * 知识库导出工具 — 把整个知识库导出为 ZIP
 */
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { showToastMsg } from './toast'

/** 导出知识库为 ZIP（指定 kbId 和 kbName，供卡片 / 文档列表弹窗共用） */
export async function exportKnowledgeBaseZip(kbId: string, kbName: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const savePath = await save({
      defaultPath: `${kbName}.zip`,
      filters: [
        {
          name: t('ZIP 文件'),
          extensions: ['zip'],
        },
      ],
    })
    if (!savePath) return

    showToastMsg(tpl('正在导出「$__name__」...', { name: kbName }), 'info')
    await ragService.exportKnowledgeBase(kbId, savePath)
    showToastMsg(tpl('导出成功：$__path__', { path: savePath }), 'success')
  } catch (err: any) {
    showToastMsg(tpl('导出失败: $__error__', { error: err.message }), 'error')
  }
}
