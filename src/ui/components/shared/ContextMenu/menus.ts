/**
 * menus — 右键菜单项工厂：文件 / 图片 / 只读文本三类，供消息气泡、图片预览浮层、
 * 工具调用卡片、终端等按需取用，文案与失败兜底只有一份。
 *
 * 属 ui 层，可依赖 i18n / Toast（`utils/clipboard.ts` 刻意不依赖它，只回答「成功没有」，
 * 由本文件翻译成人话）。
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

function toastFail(message: string): void {
  showToast(message)
}

/**
 * 文件 / 目录菜单：打开、编辑器打开、在文件管理器中显示、复制路径。
 *
 * `openPath` / `revealItemInDir` 只认绝对路径，而 LLM 入参常是相对工作目录的（如 `src/a.ts`）
 * —— 调用方务必传 workspace，否则系统会定位错地方。
 * reveal 由 capabilities 的 `opener:default` 覆盖（含 allow-reveal-item-in-dir），无需单独授权。
 *
 * `withOpen:false` 跳过「打开」（系统默认程序）：宿主自己已经有同名入口时别再给第二个。
 */
export function fileMenuItems(
  path: string,
  opts: { isDir?: boolean; workspace?: string; line?: number; withOpen?: boolean } = {},
): ContextMenuItem[] {
  // 已是绝对路径 / 无 workspace 时原样返回
  const target = toAbsolutePath(path, opts.workspace)
  const items: ContextMenuItem[] = opts.withOpen === false ? [] : [
    {
      key: 'open',
      label: opts.isDir ? t('打开文件夹') : t('打开'),
      onClick: () => {
        openPath(target).catch(() => toastFail(t('打开失败')))
      },
    },
  ]

  // 与文件工具卡片给 CodeBlock 配的动作同源：都走 editorService.openFile（按设置里的编辑器
  // 命令模板启动，未配置则回退首个预设）。目录不适用，跳过。
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
          // 未启用时给可执行指引（与目录树等入口同一句话）
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
 * 复制走「原生 CF_DIB → ClipboardItem」两级兜底（见 utils/clipboard.ts）；
 * 另存为取消不算失败（不提示）。
 *
 * `opts.mime`：src 是 blob URL（工作目录面板）时必须传，否则扩展名与 ClipboardItem 的类型都无从得知。
 */
export function imageMenuItems(
  src: string,
  opts: { namePrefix?: string; mime?: string } = {},
): ContextMenuItem[] {
  return [
    {
      key: 'copy-image',
      label: t('复制图片'),
      onClick: async () => {
        try {
          // 没有 mime 时**不传第二个参数**：普通图片（dataURL / 带扩展名的路径）本就能自己判定，
          // 多传一个 `{ mime: undefined }` 既没意义，也会让既有调用方的断言失真
          const ok = opts.mime
            ? await copyImageToClipboard(src, { mime: opts.mime })
            : await copyImageToClipboard(src)
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
          const name = defaultImageName(opts.namePrefix)
          const saved = opts.mime
            ? await saveImageAs(src, name, { mime: opts.mime })
            : await saveImageAs(src, name)
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
 * 选区优先是刻意的：菜单叫「复制」而用户已拖选半句话时，期望复制的是那半句
 * （与终端 Ctrl+C 的约定一致）。`copyLabel` 供「复制」在别处有更具体称呼的场景
 * （如代码块的「复制代码」）。
 *
 * `getSelected` 给「选区不能直接从 window 拿」的场景用（图片 OCR 文字层要按行补换行、
 * 退路面板要看自己的根节点）；它在**点菜单项那一刻**被调用，所以调用方得自己兼顾
 * 「浏览器已经把选区折叠掉」的情况。
 */
export function textMenuItems(
  getText: () => string,
  opts: {
    selectAll?: () => void
    allLabel?: string
    copyLabel?: string
    getSelected?: () => string
  } = {},
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      key: 'copy',
      label: opts.copyLabel ?? t('复制'),
      onClick: async () => {
        const selected = opts.getSelected?.() ?? window.getSelection?.()?.toString() ?? ''
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
      // 全选后通常紧接着「复制」，菜单保持打开（与终端菜单同一约定）
      keepOpen: true,
    })
  }
  return items
}
