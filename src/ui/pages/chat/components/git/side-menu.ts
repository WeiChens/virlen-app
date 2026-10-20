/**
 * side-menu — 差异弹窗左清单（`.git-diff-side` 那一列）的**行右键菜单**。
 *
 * 两个弹窗（工作区差异 `GitDiffModal` / 提交详情 `GitCommitModal`）列的是同一份文件清单，右键要给
 * 的也是同一批「基本操作」：**打开 / 编辑器打开 / 在文件管理器中显示 / 复制路径** 直接复用
 * `ContextMenu/menus.ts::fileMenuItems` —— 文案与失败兜底全应用只有一份（铁律 9）；
 * 工作区侧再补这个场景特有的两项：「暂存 / 取消暂存」（与行内那颗 ＋/－ 同一语义）与
 * 「引用到输入框」（与面板的行、目录树同一入口，不必关掉弹窗回列表再点一次）。
 *
 * 两条口径：
 * 1. 路径是**仓库根相对**（Rust 的口径），必须带 `workspace` 才能补成绝对路径 ——
 *    `openPath` / `revealItemInDir` 只认绝对路径，缺了它系统会定位到别处去；
 * 2. `exists === false`（工作区侧 x / y 为 `D`）时**只留「复制路径」**：文件在磁盘上已经不存在，
 *    打开 / 定位必然失败，点一下弹「打开失败」不如不给（与 `GitChangeRow` 同一取舍）。
 */
import { t } from '@/ui/i18n'
import { fileMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'

/** 「打开类」动作的 key：已删除的文件要摘掉它们（只剩「复制路径」还有意义） */
const OPEN_ITEM_KEYS = new Set(['open', 'open-in-editor', 'reveal'])

export interface DiffSideMenuArgs {
  /** 仓库根相对路径 */
  path: string
  /** 仓库根：`fileMenuItems` 用它把相对路径补成绝对路径 */
  workspace?: string
  /** 磁盘上还有这个文件吗？`false` = 已删除 → 摘掉打开类动作 */
  exists?: boolean
  /** 写入口（只有工作区侧有）：文案由调用方给（暂存更改 / 取消暂存） */
  staging?: { label: string; disabled?: boolean; run: () => void }
  /** 引用到输入框（换成绝对路径、剔除已删除文件都由调用方做） */
  onAttach?: () => void
}

/** 组装左清单一行的菜单项（渲染时才现算：目标行决定动作方向与可用性） */
export function diffSideMenuItems(args: DiffSideMenuArgs): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  if (args.staging) {
    const staging = args.staging
    items.push({
      key: 'staging',
      label: staging.label,
      disabled: staging.disabled,
      onClick: staging.run,
    })
  }
  if (args.onAttach) {
    const onAttach = args.onAttach
    items.push({ key: 'attach', label: t('引用到输入框'), onClick: onAttach })
  }

  const fileItems = fileMenuItems(args.path, { workspace: args.workspace }).filter(
    (item) => args.exists !== false || !OPEN_ITEM_KEYS.has(item.key),
  )
  // 上面那组是写 / 引用，这组是「把文件交给系统」：隔一条线，误点写操作的机会少一次
  if (items.length > 0 && fileItems.length > 0) {
    fileItems[0] = { ...fileItems[0], divider: true }
  }
  return [...items, ...fileItems]
}
