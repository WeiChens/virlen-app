/**
 * commit-menu — 提交行（「提交记录」与「提交图」共用）的右键菜单项。
 *
 * 两个弹窗列的是同一份提交行（`GitCommitRow`），右键能给的动作也只该有一份实现 ——
 * 各拼一遍必然漂移（一个给了「复制 hash」、另一个忘了）。
 *
 * ⚠️ 只收**后端（Rust `git/`）真做了的能力**：新建分支 = `branch::switch(create, start_point)`、
 * 挑选 / 还原 = `pick::pick`、重置 = `commit::reset_soft`、切分支 / 合并 = `branch::switch` / `merge`、
 * 撤销上次提交 = `commit::undo_last`。参考实现里常见的 Add Tag / Rebase / 多提交区间 cherry-pick
 * 本项目**没有对应命令**，所以这里**不画灰项** —— 一个点不动的入口比没有更糟。
 *
 * ⚠️ **`scope` 决定「挑选」给不给**：`head`（提交记录：只有 HEAD 可达的提交）里每一行要么是 HEAD
 * 要么是它的**祖先** —— 挑一个祖先过来得到的是一条空提交（git 只会回 `now empty`），所以在那里
 * 整份都不给；`all`（提交图：含别的分支）才是挑选真正的用处。这条判据只写在这里，两个弹窗
 * 只负责如实报自己的 scope。同一条 `scope` 也给**「复制分支名称」**看门：提交记录不画引用标签，
 * 看不见的引用不该从菜单里冒出来。
 *
 * 分组的空行（`divider`）统一落在**组内第一项**上（[`pushGroup`] 一处实现）：组是给人看的，
 * 每两项之间都画横线就等于没有分组。
 *
 * 写操作失败都不在这里兜：`git-service` 的 `run()` 会带着 git 原文弹错误窗（冲突清单也在里面），
 * 成功后它自己 toast + 刷新快照。
 */
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { copyText } from '@/utils/clipboard'
import {
  mergeBranch,
  pickCommit,
  resetToCommit,
  switchBranch,
  undoLastCommit,
} from '@/services/git-service'
import type { GitCommitLogEntry, GitLogScope, GraphRef } from '@/domain/git'
import { localBranchNames } from '@/domain/git'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'

export interface CommitMenuArgs {
  entry: GitCommitLogEntry
  /** 已解析的引用（`parseCommitRefs(entry.refs)`）：决定「切到分支 / 合并分支」给不给、给哪个 */
  refs?: GraphRef[]
  /** 当前分支：它自己不进这两项（切到自己 / 合并到自己都只是空转） */
  currentBranch?: string | null
  /** 这一行是不是 HEAD —— 「撤销上次提交」只对它有意义 */
  isHead?: boolean
  /**
   * 这份清单的取数范围（`GitLogScope`）—— **「挑选」只给 `all`**：
   * `head` 里每一行都是 HEAD 或它的祖先，挑过来必然是一条空提交。
   */
  scope: GitLogScope
  /** 只读沙盒 / 有操作在跑 → 写入口禁用（Rust 侧同样会拒，这里是体验层） */
  disabled?: boolean
  /** 打开提交详情（不传则不出现这一项） */
  onOpen?: () => void
  /** 「在此提交上新建分支…」（不传则不出现这一项）：输入框由宿主弹窗挂载 */
  onCreateBranch?: () => void
}

/** 把一组菜单项并进总表：**组首**带分隔线（组是给人看的，逐项画线等于没分组） */
function pushGroup(items: ContextMenuItem[], group: ContextMenuItem[]): void {
  if (group.length === 0) return
  const [first, ...rest] = group
  items.push({ ...first, divider: items.length > 0 }, ...rest)
}

/** 组装一条提交的菜单项（渲染时才现算：目标行决定给哪些动作） */
export function commitMenuItems(args: CommitMenuArgs): ContextMenuItem[] {
  const { entry } = args
  const refs = args.refs ?? []
  const current = args.currentBranch ?? null
  // 本地分支优先；这一行只挂着远程引用时才退到远程（`git merge origin/x` 是合法动作）。
  // ⚠️ 切换不跟这条退让：`git switch origin/x` 会 detach，从提交行上右键「切到一个远程分支」
  //    留下的游离 HEAD 没人看得懂（面板里那条路是显式的「游离」入口）。
  const local = refs.find((r) => r.kind === 'branch' && r.name !== current)
  const remote = refs.find((r) => r.kind === 'remote' && r.name !== current)
  const mergeName = local?.name ?? remote?.name
  const isHead = args.isHead === true

  const items: ContextMenuItem[] = []
  if (args.onOpen) {
    items.push({ key: 'open', label: t('查看提交详情'), onClick: args.onOpen })
  }

  // ① 在历史上下手：新建分支 / 挑选 / 还原 / 重置
  const history: ContextMenuItem[] = []
  if (args.onCreateBranch) {
    history.push({
      key: 'create-branch',
      label: t('在此提交上新建分支…'),
      disabled: args.disabled,
      onClick: args.onCreateBranch,
    })
  }
  // ⚠️ 「挑选 HEAD」保证空转（得到一条空提交的报错）、「重置到 HEAD」`commits == 0` 被 Rust 拒 ——
  //    HEAD 那行两项都不给（那行已经有「撤销上次提交」）；
  //    `head` 范围内连普通行也不给挑选：它们都是 HEAD 的祖先，挑过来同样是空提交。
  if (!isHead && args.scope === 'all') {
    history.push({
      key: 'cherry-pick',
      label: t('挑选这条提交（cherry-pick）'),
      disabled: args.disabled,
      onClick: () => void pickCommit('cherry-pick', entry.oid, entry.subject),
    })
  }
  // 还原 HEAD 是常见动作（刚提交错了要反悔），根提交也允许（git 会回一句它自己的话）
  history.push({
    key: 'revert',
    label: t('还原这条提交（revert）'),
    disabled: args.disabled,
    onClick: () => void pickCommit('revert', entry.oid, entry.subject),
  })
  if (!isHead) {
    history.push({
      key: 'reset-soft',
      label: t('重置当前分支到这笔提交（保留改动）'),
      danger: true,
      disabled: args.disabled,
      onClick: () => void resetToCommit(entry.oid, entry.subject),
    })
  }
  pushGroup(items, history)

  // ② 这一行挂着分支引用：切过去 / 把它合进来
  const branchGroup: ContextMenuItem[] = []
  if (local) {
    branchGroup.push({
      key: 'switch',
      label: tpl('切换到分支 $__name__', { name: local.name }),
      disabled: args.disabled,
      onClick: () => void switchBranch(local.name, false),
    })
  }
  if (mergeName) {
    branchGroup.push({
      key: 'merge',
      label: tpl('合并 $__name__ 到当前分支', { name: mergeName }),
      disabled: args.disabled,
      onClick: () => void mergeBranch(mergeName),
    })
  }
  pushGroup(items, branchGroup)

  // ③ HEAD 才有「撤销上次提交」（= reset --soft HEAD~1）
  if (isHead) {
    pushGroup(items, [
      {
        key: 'undo',
        label: t('撤销上次提交'),
        disabled: args.disabled,
        onClick: () => void undoLastCommit(),
      },
    ])
  }

  // ④ 复制类不受写入口禁用影响（读错了也不会坏事）；标题为空就没有可复制的，置灰
  const copies: ContextMenuItem[] = [
    {
      key: 'copy-hash',
      label: t('复制提交 hash'),
      onClick: async () => {
        const ok = await copyText(entry.oid)
        showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
      },
    },
    {
      key: 'copy-subject',
      label: t('复制提交标题'),
      disabled: !entry.subject,
      onClick: async () => {
        const ok = await copyText(entry.subject)
        showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
      },
    },
  ]
  // ④-① 复制分支名：**一个本地分支一条** —— 行上只摆得下一个标签，进 `+n` 能徽标的那些，
  //   正是要把它名字拿走的时候（远程引用不给：那是云端的倒影，本名就是 `x`，见 `localBranchNames`）。
  //   只在提交图（`all`）给：提交记录不画引用标签，看不见的引用不该从菜单里冒出来。
  if (args.scope === 'all') {
    for (const name of localBranchNames(refs)) {
      copies.push({
        key: `copy-branch:${name}`,
        label: tpl('复制分支名称 $__name__', { name }),
        onClick: async () => {
          const ok = await copyText(name)
          showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
        },
      })
    }
  }
  pushGroup(items, copies)
  return items
}
