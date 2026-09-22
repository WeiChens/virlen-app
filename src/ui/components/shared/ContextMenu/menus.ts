/**
 * menus — 右键菜单项工厂
 *
 * 把「同一类右键对象」的菜单收在一处：文件、图片、只读文本。
 * 各处（消息气泡 / 图片预览浮层 / 工具调用卡片 / 终端）只挑需要的工厂调用，
 * 文案、提示、失败兜底都只有一份实现。
 *
 * 这里属于 ui 层：可以依赖 i18n / Toast（`utils/clipboard.ts` 则刻意不依赖，
 * 它只回答「成功没有」，由本文件翻译成人话）。
 */
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { toAbsolutePath } from '@/utils/common'
import {
  copyImageToClipboard,
  copyText,
  defaultImageName,
  saveImageAs,
} from '@/utils/clipboard'
import { editorService } from '@/services/editor-service'
import type { ContextMenuItem } from './index'

/** 打开失败/未实现时统一提示（不弹原生报错，避免打断） */
function toastFail(message: string): void {
  showToast(message)
}

/**
 * 文件 / 目录菜单：打开、编辑器打开、在文件管理器中显示、复制路径。
 *
 * 「在文件管理器中显示」走 `revealItemInDir`，它由 capabilities 的
 * `opener:default` 覆盖（已含 allow-reveal-item-in-dir），无需单独授权。
 *
 * ⚠️ `openPath` / `revealItemInDir` 只认**绝对路径**，而工具入参里 LLM 常写
 * 相对工作目录的路径（如 `src/a.ts`）。不经 `workspace` 补齐就丢给系统，
 * 资源管理器会定位错地方。调用方有空时**务必传 workspace**。
 */
export function fileMenuItems(
  path: string,
  opts: { isDir?: boolean; workspace?: string; line?: number } = {},
): ContextMenuItem[] {
  // 相对路径 → 绝对路径（已是绝对路径 / 无从得知工作目录时原样返回）
  const target = toAbsolutePath(path, opts.workspace)
  const items: ContextMenuItem[] = [
    {
      key: 'open',
      label: opts.isDir ? t('打开文件夹') : t('打开'),
      onClick: () => {
        openPath(target).catch(() => toastFail(t('打开失败')))
      },
    },
  ]

  // 「编辑器打开」：与文件工具卡片（ReadFileMessage / WriteFileMessage / EditFileMessage）
  // 里给 CodeBlock 配的动作**同源** —— 都走 editorService.openFile（按设置里的编辑器命令模板
  // 启动，未配置则回退首个预设）。目录不适用，故跳过。
  if (!opts.isDir) {
    items.push({
      key: 'open-in-editor',
      label: t('编辑器打开'),
      onClick: async () => {
        const result = await editorService.openFile({
          filePath: target,
          line: opts.line,
        })
        if (!result.ok) {
          // 未启用时给出可执行的指引（与目录树等其他入口同一句话）
          showToast(
            editorService.isEnabled()
              ? t('打开失败')
              : t('请先在「设置 → 编辑器」中启用「打开编辑器」'),
          )
        }
      },
    })
  }

  items.push(
    {
      key: 'reveal',
      label: t('在文件管理器中显示'),
      onClick: () => {
        revealItemInDir(target).catch(() => toastFail(t('打开失败')))
      },
    },
    {
      key: 'copy-path',
      label: t('复制路径'),
      onClick: async () => {
        const ok = await copyText(target)
        showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
      },
    },
  )

  return items
}

/**
 * 图片菜单：复制图片、另存为。
 *
 * 复制走「原生 CF_DIB → 浏览器 ClipboardItem」两级兜底（见 utils/clipboard.ts）；
 * 另存为弹系统保存对话框，取消不算失败（不提示）。
 */
export function imageMenuItems(
  src: string,
  opts: { namePrefix?: string } = {},
): ContextMenuItem[] {
  return [
    {
      key: 'copy-image',
      label: t('复制图片'),
      onClick: async () => {
        try {
          const ok = await copyImageToClipboard(src)
          showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
        } catch {
          showToast(t('复制失败'))
        }
      },
    },
    {
      key: 'save-as',
      label: t('另存为'),
      onClick: async () => {
        try {
          const saved = await saveImageAs(
            src,
            defaultImageName(opts.namePrefix),
          )
          if (saved) showToast(tpl('已保存到 $__path__', { path: saved }))
        } catch {
          showToast(t('保存失败'))
        }
      },
    },
  ]
}

/**
 * 只读文本菜单：复制（**选区优先**，无选区才整段）、全选。
 *
 * 选区优先是刻意的：菜单项叫「复制」，用户已经拖选了半句话时，
 * 期望复制的就是那半句而不是整段（与终端 Ctrl+C 的约定一致）。
 */
export function textMenuItems(
  getText: () => string,
  opts: { selectAll?: () => void; allLabel?: string } = {},
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      key: 'copy',
      label: t('复制'),
      onClick: async () => {
        const selected = window.getSelection?.()?.toString() ?? ''
        const text = selected || getText()
        const ok = await copyText(text)
        showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
      },
    },
  ]
  if (opts.selectAll) {
    items.push({
      key: 'select-all',
      label: opts.allLabel ?? t('全选'),
      onClick: opts.selectAll,
      // 全选后通常紧接着还要「复制」，菜单保持打开（与终端菜单同一约定）
      keepOpen: true,
    })
  }
  return items
}
