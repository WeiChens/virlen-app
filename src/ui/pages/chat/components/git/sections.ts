/**
 * sections — 变更列表的**分段视图模型**（面板的列表与差异弹窗左侧的文件清单共用这一份）。
 *
 * 为什么单独一份：段的数量 / 顺序 / 标题 / 「这一段属于哪一侧」/ 批量入口原先散在 `GitPanel` 的
 * `renderSection` 调用里，而差异弹窗的侧边栏要列同一份东西 —— 抄第二遍必然漂移（改了一处，
 * 另一处还按老口径渲染）。这里只描述「长什么样」，数据仍来自 `domain/git` 的分组纯函数。
 *
 * ⚠️ `side` 不只是分类，它同时决定**差异基准**与**写操作方向**：`staged` = index↔HEAD、只能取消暂存；
 * `unstaged` = 工作区↔index、只能暂存 / 丢弃（未跟踪与冲突都落在这一侧）。
 */
import { t } from '@/ui/i18n'
import type { GitChangeEntry, GitGroups } from '@/domain/git'

export type GitSectionKey = 'staged' | 'unstaged' | 'conflicts'

/** 一段的渲染描述 */
export interface GitChangeSection {
  key: GitSectionKey
  title: string
  side: 'staged' | 'unstaged'
  entries: GitChangeEntry[]
  /** 段标题右侧的批量入口（`null` = 这一段没有，例如冲突段） */
  bulk: { label: string; run: () => void } | null
}

export interface GitSectionActions {
  stage: (paths: string[]) => void
  unstage: (paths: string[]) => void
}

const paths = (list: GitChangeEntry[]): string[] => list.map((entry) => entry.path)

/**
 * 三段：**暂存的更改 → 更改 → 冲突**（顺序 / 命名对齐 VS Code）。
 *
 * ⚠️ **未跟踪不再单独成段**（实测反馈）：它就是「更改」的一项，只是没进过 index —— 与 VS Code 同口径。
 * 单列一段会让「我到底改了几个文件」被拆成两处看，也会让人以为未跟踪的文件不算「更改」。
 * （`domain/git/group.ts` 仍保留四组：那是 porcelain 的**忠实映射**，合并只发生在这一层展示口径。）
 *
 * 「全部暂存」= 未暂存的全暂存（已跟踪改动 + 未跟踪一起，方案 §5.4 的 `git add -A`）——
 * 用户按下它要的是「没暂存的全暂存」，不是「只暂存这一小类」。
 */
export function changeSections(
  groups: GitGroups,
  actions: GitSectionActions,
): GitChangeSection[] {
  const stageAll = (): void => {
    actions.stage([...paths(groups.unstaged), ...paths(groups.untracked)])
  }
  return [
    {
      key: 'staged',
      title: t('暂存的更改'),
      side: 'staged',
      entries: groups.staged,
      bulk: {
        label: t('全部取消暂存'),
        run: () => actions.unstage(paths(groups.staged)),
      },
    },
    {
      key: 'unstaged',
      title: t('更改'),
      side: 'unstaged',
      // 已跟踪的改动在前、未跟踪在后（与 VS Code 的排序一致：先「改过的」后「新来的」）
      entries: [...groups.unstaged, ...groups.untracked],
      bulk: { label: t('全部暂存'), run: stageAll },
    },
    // 冲突段不给批量入口：冲突文件的「暂存」在 git 里是「标记已解决」，与普通暂存不是一回事
    //（方案 §5.2：P1 只展示），混进批量就把两件事做成一件事了
    {
      key: 'conflicts',
      title: t('冲突'),
      side: 'unstaged',
      entries: groups.conflicts,
      bulk: null,
    },
  ]
}

/**
 * 一行的稳定标识（选中集用它）：**侧 + 路径**。
 *
 * 只按路径会串味 —— 同一个文件可以在「暂存的更改」与「更改」两段各出现一次（git 的真实语义，
 * 两段的 diff 基准不同）。分隔符取 NUL：路径里不可能出现它（POSIX / Windows 都禁止），
 * 于是拼接不会歧义。
 */
export function rowKey(side: 'staged' | 'unstaged', path: string): string {
  return `${side}\u0000${path}`
}

/** `rowKey` 的逆运算（批量动作要知道选中的每一行属于哪一侧） */
export function splitRowKey(key: string): {
  side: 'staged' | 'unstaged'
  path: string
} {
  const at = key.indexOf('\u0000')
  return {
    side: key.slice(0, at) === 'staged' ? 'staged' : 'unstaged',
    path: key.slice(at + 1),
  }
}
