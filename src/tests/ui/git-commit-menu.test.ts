/**
 * 提交行的右键菜单项（`git/commit-menu.ts`）：**给了哪些项、按什么条件给**。
 *
 * 这里是「提交记录」与「提交图」共用的唯一组装处，所以口径全钉在用例里：
 * - 引用决定分支类入口：行上有本地分支 → 切到它 + 合并它；只有远程引用 → 只给合并（切换会 detach）；
 * - 当前分支自己不给（切到自己 / 合并到自己是空转）；行不是 HEAD 就没有「撤销上次提交」；
 * - 历史类三项：挑选 / 还原 / 重置 —— 非 HEAD 全给，HEAD 只给还原（挑选与重置在 HEAD 上是保证空转的动作）；
 *   而「提交记录」视图（`scope = 'head'`）**整份不给挑选** —— 那里每一行都是 HEAD 或它的祖先，挑了必是空提交；
 * - 「在此提交上新建分支…」由宿主给回调才出现（输入框挂在宿主的弹窗里）；
 * - 复制类永远在（写入口被 `disabled` 时也能复制），标题为空则置灰；
 * - 「复制分支名称」**一个本地分支一条**，且只在提交图（`scope = 'all'`）出现：提交记录不画引用标签，
 *   远程引用与标签不进这组（远程是云端的倒影，本名就是它自己那一截）。
 * - 分隔线只落在**组首**（逐项画线等于没分组）。
 *
 * 菜单本体（定位 / 关闭 / 点菜单项不关弹窗）由 `context-menu.test.tsx` 与两个弹窗的用例守。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): unknown => ({ Toast: (): null => null, showToast: vi.fn() }),
}))
vi.mock('@/services/git-service', () => ({
  switchBranch: vi.fn(() => Promise.resolve(true)),
  mergeBranch: vi.fn(() => Promise.resolve(true)),
  undoLastCommit: vi.fn(() => Promise.resolve(true)),
  pickCommit: vi.fn(() => Promise.resolve(true)),
  resetToCommit: vi.fn(() => Promise.resolve(true)),
}))

import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import {
  mergeBranch,
  pickCommit,
  resetToCommit,
  switchBranch,
  undoLastCommit,
} from '@/services/git-service'
import { commitMenuItems } from '@/ui/pages/chat/components/git/commit-menu'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'
import type { GitCommitLogEntry, GraphRef } from '@/domain/git'

const OID = 'a'.repeat(40)

function entry(over: Partial<GitCommitLogEntry> = {}): GitCommitLogEntry {
  return {
    oid: OID,
    short_oid: 'aaaaaaa',
    author_name: '张三',
    author_email: 'zhangsan@example.com',
    author_time: '2026-10-16T10:29:46+08:00',
    parents: [],
    refs: [],
    subject: 'fix: 优化 diff',
    ...over,
  }
}

const labels = (items: ContextMenuItem[]): unknown[] => items.map((i) => i.label)
const item = (items: ContextMenuItem[], label: string): ContextMenuItem => {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`菜单里没有「${label}」`)
  return found
}

/** 历史类三项（非 HEAD 的行才有这么全） */
const HISTORY_LABELS = [
  '挑选这条提交（cherry-pick）',
  '还原这条提交（revert）',
  '重置当前分支到这笔提交（保留改动）',
]

beforeEach(() => {
  vi.mocked(copyText).mockClear()
  vi.mocked(showToast).mockClear()
  vi.mocked(switchBranch).mockClear()
  vi.mocked(mergeBranch).mockClear()
  vi.mocked(undoLastCommit).mockClear()
  vi.mocked(pickCommit).mockClear()
  vi.mocked(resetToCommit).mockClear()
})

describe('提交行的右键菜单', () => {
  it('没有引用、也不是 HEAD：详情 + 历史三项 + 两个复制，分隔线只落在组首', () => {
    const onOpen = vi.fn()
    const items = commitMenuItems({ entry: entry(), scope: 'all', onOpen })

    expect(labels(items)).toEqual([
      '查看提交详情',
      ...HISTORY_LABELS,
      '复制提交 hash',
      '复制提交标题',
    ])
    // 第一组前面没有线；历史组与复制组各有一条，且都只在组首
    expect(items[0].divider).toBeFalsy()
    expect(item(items, '挑选这条提交（cherry-pick）').divider).toBe(true)
    expect(item(items, '还原这条提交（revert）').divider).toBeFalsy()
    expect(item(items, '重置当前分支到这笔提交（保留改动）').divider).toBeFalsy()
    expect(item(items, '复制提交 hash').divider).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('挑选 / 还原 / 重置各自把 oid 与 kind 传对后端', () => {
    const items = commitMenuItems({ entry: entry(), scope: 'all' })

    item(items, '挑选这条提交（cherry-pick）').onClick()
    expect(pickCommit).toHaveBeenCalledWith('cherry-pick', OID, 'fix: 优化 diff')

    item(items, '还原这条提交（revert）').onClick()
    expect(pickCommit).toHaveBeenLastCalledWith('revert', OID, 'fix: 优化 diff')

    item(items, '重置当前分支到这笔提交（保留改动）').onClick()
    expect(resetToCommit).toHaveBeenCalledWith(OID, 'fix: 优化 diff')
  })

  it('HEAD 那一行：只给「还原」，挑选与重置都是保证空转的动作', () => {
    const items = commitMenuItems({ entry: entry(), scope: 'all', isHead: true })
    expect(labels(items)).toEqual([
      '还原这条提交（revert）',
      '撤销上次提交',
      '复制提交 hash',
      '复制提交标题',
    ])
    expect(labels(items)).not.toContain('挑选这条提交（cherry-pick）')
    expect(labels(items)).not.toContain('重置当前分支到这笔提交（保留改动）')

    item(items, '还原这条提交（revert）').onClick()
    expect(pickCommit).toHaveBeenCalledWith('revert', OID, 'fix: 优化 diff')
  })

  it('提交记录视图（scope=head）：整份不给「挑选」—— 每一行都是 HEAD 的祖先，挑了必是空提交', () => {
    const items = commitMenuItems({ entry: entry(), scope: 'head' })
    expect(labels(items)).toEqual([
      '还原这条提交（revert）',
      '重置当前分支到这笔提交（保留改动）',
      '复制提交 hash',
      '复制提交标题',
    ])
    expect(labels(items)).not.toContain('挑选这条提交（cherry-pick）')
    // 还原与重置对祖先提交都有意义（反悔一笔改动 / 把分支退到这里），照给
    expect(labels(items)).toContain('还原这条提交（revert）')
    expect(labels(items)).toContain('重置当前分支到这笔提交（保留改动）')
  })

  it('「在此提交上新建分支…」由宿主给回调才出现（输入框在宿主里）', () => {
    const onCreateBranch = vi.fn()
    const items = commitMenuItems({ entry: entry(), scope: 'all', onCreateBranch })

    expect(labels(items)[0]).toBe('在此提交上新建分支…')
    // 新建分支是历史组的第一项 → 它自己带组首分隔线（前面有「查看详情」时不带，这里没有 onOpen）
    expect(item(items, '在此提交上新建分支…').divider).toBeFalsy()

    item(items, '在此提交上新建分支…').onClick()
    expect(onCreateBranch).toHaveBeenCalledTimes(1)

    // 不传就没有这一项（输入框是宿主的事，菜单不替它决定）
    expect(labels(commitMenuItems({ entry: entry(), scope: 'all' }))).not.toContain(
      '在此提交上新建分支…',
    )
  })

  it('行上有本地分支：切到它 + 合并到当前分支（两项都调后端），当前分支自己不给', () => {
    const refs: GraphRef[] = [
      { name: 'feature', kind: 'branch' },
      { name: 'origin/feature', kind: 'remote' },
    ]
    const items = commitMenuItems({ entry: entry(), scope: 'all', refs, currentBranch: 'master' })

    // 本地分支优先：只给一条（挂着的远程引用是它的倒影，不必再来一条）
    expect(labels(items)).toEqual([
      ...HISTORY_LABELS,
      '切换到分支 feature',
      '合并 feature 到当前分支',
      '复制提交 hash',
      '复制提交标题',
      '复制分支名称 feature',
    ])
    // 分支组的第一项带分隔线
    expect(item(items, '切换到分支 feature').divider).toBe(true)

    item(items, '切换到分支 feature').onClick()
    expect(switchBranch).toHaveBeenCalledWith('feature', false)

    item(items, '合并 feature 到当前分支').onClick()
    expect(mergeBranch).toHaveBeenCalledWith('feature')
  })

  it('行上只有远程引用：只给「合并」（`git switch origin/x` 会 detach，不给切换）', () => {
    const items = commitMenuItems({
      entry: entry(),
      scope: 'all',
      refs: [{ name: 'origin/hotfix', kind: 'remote' }],
      currentBranch: 'master',
    })

    expect(labels(items)).toEqual([
      ...HISTORY_LABELS,
      '合并 origin/hotfix 到当前分支',
      '复制提交 hash',
      '复制提交标题',
    ])
  })

  it('行上的分支就是当前分支（head 引用 / 同名）：两项都不给，不给空转入口', () => {
    const items = commitMenuItems({
      entry: entry(),
      scope: 'all',
      refs: [{ name: 'master', kind: 'head' }],
      currentBranch: 'master',
    })
    expect(labels(items)).toEqual([
      ...HISTORY_LABELS,
      '复制提交 hash',
      '复制提交标题',
      '复制分支名称 master',
    ])

    // 标签与远端倒影都只是当前分支时同样不给（`merge master` 只会 Already up to date）
    const echo = commitMenuItems({
      entry: entry(),
      scope: 'all',
      refs: [
        { name: 'master', kind: 'branch' },
        { name: 'origin/master', kind: 'remote' },
      ],
      currentBranch: 'master',
    })
    expect(labels(echo)).toEqual([
      ...HISTORY_LABELS,
      '合并 origin/master 到当前分支',
      '复制提交 hash',
      '复制提交标题',
      '复制分支名称 master',
    ])
  })

  it('「撤销上次提交」只给 HEAD 那一行，且带分隔线', () => {
    const head = commitMenuItems({ entry: entry(), scope: 'all', isHead: true })
    expect(labels(head)).toEqual([
      '还原这条提交（revert）',
      '撤销上次提交',
      '复制提交 hash',
      '复制提交标题',
    ])
    expect(item(head, '撤销上次提交').divider).toBe(true)

    item(head, '撤销上次提交').onClick()
    expect(undoLastCommit).toHaveBeenCalledTimes(1)

    // 非 HEAD 的行没有这一项（撤的是「上一条」，不是「这一条」）
    expect(labels(commitMenuItems({ entry: entry(), scope: 'all' }))).not.toContain(
      '撤销上次提交',
    )
  })

  it('只读沙盒 / 有操作在跑：写入口置灰，复制照旧可用', () => {
    const items = commitMenuItems({
      entry: entry(),
      scope: 'all',
      refs: [{ name: 'feature', kind: 'branch' }],
      currentBranch: 'master',
      disabled: true,
      onCreateBranch: vi.fn(),
    })

    expect(item(items, '在此提交上新建分支…').disabled).toBe(true)
    expect(item(items, '挑选这条提交（cherry-pick）').disabled).toBe(true)
    expect(item(items, '还原这条提交（revert）').disabled).toBe(true)
    expect(item(items, '重置当前分支到这笔提交（保留改动）').disabled).toBe(true)
    expect(item(items, '切换到分支 feature').disabled).toBe(true)
    expect(item(items, '合并 feature 到当前分支').disabled).toBe(true)
    expect(item(items, '复制提交 hash').disabled).toBeFalsy()
  })

  it('复制 hash 拿完整 oid、复制标题拿单行 subject，并给「已复制」提示', async () => {
    const items = commitMenuItems({ entry: entry(), scope: 'all' })

    await item(items, '复制提交 hash').onClick()
    expect(copyText).toHaveBeenCalledWith(OID)
    expect(showToast).toHaveBeenCalledWith('已复制到剪贴板')

    await item(items, '复制提交标题').onClick()
    expect(copyText).toHaveBeenLastCalledWith('fix: 优化 diff')

    // 复制失败要说出来（`copyText` 只回答成功没有）
    vi.mocked(copyText).mockResolvedValueOnce(false)
    await item(items, '复制提交 hash').onClick()
    expect(showToast).toHaveBeenLastCalledWith('复制失败')
  })

  it('复制分支名称：一个本地分支一条，远程与标签不进，且只在提交图给', async () => {
    const refs: GraphRef[] = [
      { name: 'master', kind: 'head' },
      { name: 'feature', kind: 'branch' },
      { name: 'hotfix', kind: 'branch' },
      { name: 'origin/master', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
    ]
    const items = commitMenuItems({ entry: entry(), scope: 'all', refs, currentBranch: 'master' })

    // 三个本地分支 → 三条（`HEAD -> refs/heads/master` 的 name 就是 master，不能漏）
    expect(labels(items).filter((l) => String(l).startsWith('复制分支名称'))).toEqual([
      '复制分支名称 master',
      '复制分支名称 feature',
      '复制分支名称 hotfix',
    ])
    // 远程与标签不在这一组：前者是云端的倒影（复制出来还得剥前缀），后者不是可 checkout 的线
    expect(labels(items)).not.toContain('复制分支名称 origin/master')
    expect(labels(items)).not.toContain('复制分支名称 v1.0')

    // 点哪条就复制哪个名字（不是这一行的某一个「代表分支」）
    await item(items, '复制分支名称 hotfix').onClick()
    expect(copyText).toHaveBeenLastCalledWith('hotfix')
    expect(showToast).toHaveBeenLastCalledWith('已复制到剪贴板')

    // 游离 HEAD 只有字面量 HEAD —— 那不是一条可以 checkout 的线
    expect(
      labels(
        commitMenuItems({ entry: entry(), scope: 'all', refs: [{ name: 'HEAD', kind: 'head' }] }),
      ),
    ).not.toContain('复制分支名称 HEAD')

    // 提交记录（scope=head）不画引用标签 → 整组都不给
    expect(
      labels(commitMenuItems({ entry: entry(), scope: 'head', refs })).filter((l) =>
        String(l).startsWith('复制分支名称'),
      ),
    ).toEqual([])
  })

  it('空标题（--allow-empty-message）没有可复制的 → 那一项置灰', () => {
    const items = commitMenuItems({ entry: entry({ subject: '' }), scope: 'all' })
    expect(item(items, '复制提交标题').disabled).toBe(true)
    // 完整 oid 永远有，不受影响
    expect(item(items, '复制提交 hash').disabled).toBeFalsy()
  })
})
