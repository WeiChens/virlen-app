/**
 * GitChangeRow — 变更列表的一行（文件类型图标 + 文件名 + 目录 + 状态字母 + hover 操作 + 右键菜单）。
 *
 * 行的两种身份由 `side` 决定，**它同时决定差异基准**：
 * - `staged`（已暂存）：diff = index ↔ HEAD，行内只有「取消暂存」；
 * - `unstaged`（含未跟踪）：diff = 工作区 ↔ index，行内给「暂存」「丢弃」。
 *
 * ⚠️ 已暂存的行**不给「丢弃」**（与 VS Code 一致）：丢弃的对象是工作区内容，对已暂存的文件直接丢弃
 * 会留下一个「已暂存但工作区没了」的中间态，用户几乎总是想「先取消暂存再决定」。
 *
 * 行的排布（实测反馈）：**最左是文件类型图标**（`FileTypeIcon`，按扩展名分档），**状态字母贴最右**
 * —— 字母贴左会抢文件名的位置（列表主要在扫文件名）；动作排在字母**左侧**、平时 `opacity: 0`
 * 不显形（占位不撤，所以 hover 时字母不左右跳）。
 *
 * 交互（与资源管理器同口径）：**单击 = 选中**（Ctrl 加减 / Shift 选一段，选中集在 `GitPanel`），
 * **双击才打开差异**。三个动作的 `paths` 由 `GitPanel` 解析好：点在选中集里的行上时它就是
 * 同侧选中的全部（批量），此刻文案会变成「… N 个文件」—— 用户点之前就知道它带走几个。
 *
 * **拖到输入框 = 引用成附件**（与侧边栏目录树同一套指针拖拽，见 `../sidebar/use-tree-drag`）：
 * 路径口径与行内按钮完全一致（`dragPaths` 就是 `actionPaths` 的结果），拖选中集里的行带走同侧整批。
 * 拖拽松手后浏览器仍会补一次 click / dblclick，两者都要按 `draggedRef` 吞掉 —— 否则「拖到输入框」
 * 会顺手把行选中、甚至弹出差异弹窗。右键菜单另给一项「引用到输入框」：拖拽没有可见入口，
 * 面板高度压住输入框时（竖屏 / 小窗）它是唯一出路。
 *
 * 三个行内按钮都是**纯图标**：所以除了 `title` 还给 `aria-label`（读屏只念得出一串符号）；
 * 「丢弃」用 `UndoSvg` 而不是字符 `↺` —— 后者与刷新图标同形，会被读成「刷新一下」（实测反馈）。
 */
import { observer } from 'mobx-react-lite'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import { showToast } from '@/ui/components/shared/Toast'
import { toAbsolutePath } from '@/utils/common'
import UndoSvg from '@/ui/components/icons/UndoSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import { baseName, dirName, displayPath, statusLetter } from '@/domain/git'
import type { GitChangeEntry, GitFileStat } from '@/domain/git'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { copyText } from '@/utils/clipboard'
import { useTreeDrag } from '../sidebar/use-tree-drag'

/** 一行指向的东西（差异弹窗按它决定取哪两侧内容） */
export interface GitRowTarget {
  entry: GitChangeEntry
  side: 'staged' | 'unstaged'
}

interface Props {
  entry: GitChangeEntry
  side: 'staged' | 'unstaged'
  /** 只读沙盒模式 / 有操作在跑 → 所有写入口禁用（Rust 侧同样会拒，这里是体验层的双保险） */
  disabled: boolean
  /** 这一行的行数统计；`null` = 没算出来（二进制 / 冲突 / 统计还没到） → 不画数字 */
  stat: GitFileStat | null
  /** 这一行是否在选中集里（决定选中态；批量与否也看它） */
  selected: boolean
  /** 这次操作会作用于几个文件（> 1 = 批量，按钮文案跟着写清范围） */
  batch: number
  /**
   * 拖到输入框时带走哪些路径（仓库根相对）——
   * 与三个行内按钮同一口径（=`GitPanel.actionPaths`）：行在选中集里就是同侧选中的全部。
   */
  dragPaths: string[]
  /** 引用到输入框（由 `GitPanel` 换成绝对路径并剔除已删除的文件） */
  onAttach: (paths: string[]) => void
  onSelect: (mod: { shift: boolean; toggle: boolean }) => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onOpenDiff: (target: GitRowTarget) => void
}

export const GitChangeRow = observer(function GitChangeRow({
  entry,
  side,
  stat,
  disabled,
  selected,
  batch,
  dragPaths,
  onAttach,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onOpenDiff,
}: Props) {
  const menu = useContextMenu<GitRowTarget>()
  const letter = statusLetter(entry, side)
  const name = baseName(entry.path)
  const staged = side === 'staged'
  const target: GitRowTarget = { entry, side }
  /** 批量时按钮上写清作用范围（单看「暂存」二字，看不出它会带走几个文件） */
  const stageLabel =
    batch > 1 ? tpl('暂存 $__count__ 个文件', { count: batch }) : t('暂存更改')
  const unstageLabel =
    batch > 1
      ? tpl('取消暂存 $__count__ 个文件', { count: batch })
      : t('取消暂存')
  const discardLabel =
    batch > 1 ? tpl('丢弃 $__count__ 个文件', { count: batch }) : t('丢弃更改')
  const attachLabel =
    batch > 1
      ? tpl('引用 $__count__ 项到输入框', { count: batch })
      : t('引用到输入框')

  // 拖到输入框 = 引用成附件（不用 HTML5 dnd：本项目 dragDropEnabled=true，页面收不到 drag/drop）
  const { startDrag, draggedRef } = useTreeDrag({
    onDropToInput: (items) => onAttach(items.map((item) => item.path)),
    // 变更行没有「拖进目录」这种落点（面板里不存在 [data-tree-dir]），空实现即可
    onDropIntoDir: () => {},
  })

  function buildItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    if (staged) {
      items.push({
        key: 'unstage',
        label: unstageLabel,
        disabled,
        onClick: onUnstage,
      })
    } else {
      items.push({
        key: 'stage',
        label: stageLabel,
        disabled,
        onClick: onStage,
      })
    }
    items.push({
      key: 'diff',
      label: t('查看差异'),
      onClick: () => onOpenDiff(target),
    })
    items.push({
      key: 'attach',
      label: attachLabel,
      onClick: () => onAttach(dragPaths),
    })
    // 删除的文件在工作区里已经不存在，「在文件管理器中显示」必然失败（打开的是不存在的路径）
    // —— 直接不给这一项，比点一下报错好
    const deleted = entry.x === 'D' || entry.y === 'D'
    const repoRoot = gitStore.repo?.root
    if (!deleted && repoRoot) {
      items.push({
        key: 'reveal',
        label: t('在文件管理器中显示'),
        onClick: () => {
          // 路径是仓库根相对（Rust 的口径），而 plugin-opener 只认绝对路径
          revealItemInDir(toAbsolutePath(entry.path, repoRoot)).catch(() =>
            showToast(t('打开失败')),
          )
        },
      })
    }
    items.push({
      key: 'copy',
      label: t('复制路径'),
      onClick: () => void copyText(entry.path),
    })
    if (!staged) {
      items.push({
        key: 'discard',
        label: discardLabel,
        danger: true,
        divider: true,
        disabled,
        onClick: onDiscard,
      })
    }
    return items
  }

  return (
    <>
      <div
        className={`git-row${selected ? ' selected' : ''}`}
        title={`${displayPath(entry)}\n${t('双击查看差异')}`}
        // 按下即交给拖拽 hook；按在行内按钮上不算拖拽（否则点「暂存」会连带拖出一个 ghost）
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          startDrag(
            e,
            dragPaths.map((path) => ({
              path,
              name: baseName(path),
              isDir: false,
            })),
          )
        }}
        onClick={(e) => {
          // 拖拽松手后浏览器仍会补一次 click：这一下不是「选中」，吞掉
          if (draggedRef.current) {
            draggedRef.current = false
            return
          }
          onSelect({ shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey })
        }}
        onDoubleClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false
            return
          }
          onOpenDiff(target)
        }}
        onContextMenu={(e) => menu.openAt(e, target)}>
        <FileTypeIcon filename={name} className="git-row-icon" />
        <span className="git-row-name">{name}</span>
        {/* rename 的旧路径要看得见，否则用户以为「凭空多了个文件」 */}
        <span className="git-row-dir">
          {entry.orig_path ? displayPath(entry) : dirName(entry.path)}
        </span>
        {/* 动作排上双击不冒泡：双击「＋」不该顺手把差异弹窗也打开 */}
        <span
          className="git-row-actions"
          onDoubleClick={(e) => e.stopPropagation()}>
          {staged ? (
            <button
              type="button"
              className="git-row-btn"
              title={unstageLabel}
              aria-label={unstageLabel}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation()
                onUnstage()
              }}>
              －
            </button>
          ) : (
            <>
              <button
                type="button"
                className="git-row-btn danger"
                title={discardLabel}
                aria-label={discardLabel}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation()
                  onDiscard()
                }}>
                <UndoSvg />
              </button>
              <button
                type="button"
                className="git-row-btn"
                title={stageLabel}
                aria-label={stageLabel}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation()
                  onStage()
                }}>
                ＋
              </button>
            </>
          )}
        </span>
        {/* 行数：`+a −d`。二进制 / 冲突 / 未跟踪过大没有数字，就不占位（不写 0，0 是“没改行”的意思） */}
        {stat && (stat.added !== null || stat.deleted !== null) && (
          <span className="git-row-stat">
            {stat.added !== null && <span className="add">+{stat.added}</span>}
            {stat.deleted !== null && <span className="del">−{stat.deleted}</span>}
          </span>
        )}
        {/* 状态字母贴最右（图标 / 文件名在左，动作排在其左）—— 扫文件名时不被字母打断 */}
        <span className={`git-row-letter s-${letter}`}>{letter}</span>
      </div>
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={buildItems()}
          onClose={menu.close}
        />
      )}
    </>
  )
})

export default GitChangeRow
