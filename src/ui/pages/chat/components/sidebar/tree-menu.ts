/**
 * tree-menu — 目录树条目的右键菜单项
 *
 * 复用 `ContextMenu/menus.ts::fileMenuItems`（打开 / 编辑器打开 / 在文件管理器中显示 /
 * 复制路径），只在其前后补上侧边栏特有的动作：引用到输入框、复制、粘贴、重命名、删除。
 * 文案与失败兜底集中在这里，树组件只负责传回调。
 *
 * 打开类动作（fileMenuItems）只作用于右键命中的那一行，批量动作（引用 / 复制 / 删除）
 * 作用于整个选择集 —— 与资源管理器一致：多选后右键，菜单里的「打开」仍是打开点中的那个。
 */
import { t, tpl } from '@/ui/i18n'
import { fileClipboard } from '@/services/file-transfer-service'
import { fileMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'

export interface TreeMenuTarget {
  path: string
  name: string
  isDir: boolean
}

export interface TreeMenuActions {
  /** 把选中的条目作为附件挂到输入框 */
  onAttach: () => void
  /** 复制（写入应用内文件剪贴板） */
  onCopy: () => void
  /** 粘贴进目标目录（目录本身 / 文件所在目录） */
  onPaste: () => void
  onRename: () => void
  onDelete: () => void
}

export function workspaceTreeMenuItems(args: {
  /** 右键命中的行（打开类动作的作用对象） */
  target: TreeMenuTarget
  /** 批量动作的作用对象（命中行不在选择集里时就是它自己） */
  targets: TreeMenuTarget[]
  /** 当前树根，用于把相对路径补成绝对路径（fileMenuItems 需要） */
  workspace: string
  actions: TreeMenuActions
}): ContextMenuItem[] {
  const { target, targets, workspace, actions } = args
  const count = targets.length
  const multi = count > 1

  return [
    {
      key: 'attach',
      label: multi
        ? tpl('引用 $__count__ 项到输入框', { count })
        : t('引用到输入框'),
      onClick: actions.onAttach,
    },
    {
      key: 'copy',
      label: multi ? tpl('复制 $__count__ 项', { count }) : t('复制'),
      onClick: actions.onCopy,
    },
    {
      key: 'paste',
      // 剪贴板为空时置灰：读的是 observable，复制后菜单会立刻可用
      label: t('粘贴'),
      disabled: !fileClipboard.hasItems,
      divider: true,
      onClick: actions.onPaste,
    },
    // 打开 / 编辑器打开（仅文件）/ 在文件管理器中显示 / 复制路径
    ...fileMenuItems(target.path, { isDir: target.isDir, workspace }),
    {
      key: 'rename',
      label: t('重命名'),
      divider: true,
      // 行内重命名一次只能改一个 → 多选时置灰
      disabled: multi,
      onClick: actions.onRename,
    },
    {
      key: 'delete',
      label: multi ? tpl('删除 $__count__ 项', { count }) : t('删除'),
      danger: true,
      onClick: actions.onDelete,
    },
  ]
}
