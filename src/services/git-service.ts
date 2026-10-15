/**
 * git-service — 「源代码管理」面板的编排层。
 *
 * 职责：**探测 / 刷新时机 / 操作串行 / 确认与提示 / 埋点**。数据取用一律经
 * `@/infrastructure/git`（唯一入口），口径判定一律用 `@/domain/git` 的纯函数。
 *
 * 三条工程口径：
 * 1. **写操作一次只允许一个**（`busy` 非空时直接拒绝）—— git 自己的 index 锁在 Rust 侧已经串行，
 *    这里再挡一层是为了**不给用户产生「点了两次」的错觉**；
 * 2. **刷新时机**（P1 不做文件监听，见方案 §7 第 9 条）：探测时 / 打开面板时 / 每次操作后 /
 *    窗口重新聚焦时 / 用户点刷新。关闭面板时**不发任何请求**；
 * 3. 读操作的取消走既有 `stop_task`：新的 status 起跑前先把上一次停掉（超大仓库连点刷新时有用）。
 *
 * ⚠️ 埋点红线：只报**动作 / 条数 / 结果**，不报仓库路径、分支名、提交信息正文（方案 §6）。
 */
import { runInAction } from 'mobx'
import {
  branches as fetchBranches,
  checkRefFormat as invokeCheckRefFormat,
  commit as invokeCommit,
  diffSides as invokeDiffSides,
  discard as invokeDiscard,
  isGitEnvAvailable,
  repoInfo,
  stage as invokeStage,
  status as fetchStatus,
  stopTask,
  switchBranch as invokeSwitchBranch,
  unstage as invokeUnstage,
} from '@/infrastructure/git'
import type { GitDiffScope, GitDiffSides } from '@/domain/git'
import { gitStore } from '@/ui/store/gitStore'
import { MessageBox as MessagePrompt } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { t, tpl } from '@/ui/i18n'
import { track } from '@/utils/telemetry'

/** 新建一个带前缀的任务 id（与目录树 / 搜索框同一套写法） */
function newTaskId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** 上一次 status 的任务 id —— 起新的之前先把它停掉 */
let statusTaskId: string | null = null

/** 错误 → 一行可读文案（Rust 侧已经把 stderr 拼进来了） */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.trim() || t('操作失败')
}

/** 统一收口：置 busy → 跑 → 清 busy → 失败落 error + toast */
async function run<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { silent?: boolean } = {},
): Promise<T | null> {
  if (gitStore.busy) return null
  const started = Date.now()
  runInAction(() => {
    gitStore.busy = label
    gitStore.error = null
  })
  try {
    const result = await fn()
    track('git.op', { op: label, ok: true, ms: Date.now() - started })
    return result
  } catch (e) {
    const text = errorText(e)
    runInAction(() => {
      gitStore.error = text
    })
    track('git.op', { op: label, ok: false, ms: Date.now() - started })
    if (!opts.silent) showToast(text, 4000)
    // 失败后立刻回读一次：列表过期是写操作失败的头号原因（用户在磁盘上改了文件，面板还拿着旧快照
    // —— 于是「界面上有这条路径、git 却说 did not match」，退出码 128）。让面板自己回到当前真相，
    // 用户不必手点刷新，也不会对着一条已经不存在的路径反复重试。
    void refreshStatus()
    return null
  } finally {
    runInAction(() => {
      gitStore.busy = null
    })
  }
}

/** 快照落地（写操作与刷新共用同一条出口） */
function acceptSnapshot(snapshot: Awaited<ReturnType<typeof fetchStatus>>): void {
  runInAction(() => {
    gitStore.snapshot = snapshot
    gitStore.error = null
  })
}

// ==================== 探测与刷新 ====================

/**
 * 切换工作目录（会话切换 / 新对话页选目录时由入口组件调用）。
 *
 * 目录没变则**不重复探测**（面板开关、窗口聚焦都会调到这里）。
 */
export async function syncWorkspace(dir: string | null): Promise<void> {
  if (gitStore.dir === dir && gitStore.probed) return
  runInAction(() => {
    gitStore.dir = dir
    gitStore.probed = false
    gitStore.repo = null
    gitStore.unavailable = null
    gitStore.snapshot = null
    gitStore.branches = []
    gitStore.error = null
  })
  if (!dir) return
  if (!isGitEnvAvailable()) {
    runInAction(() => {
      gitStore.probed = true
      gitStore.unavailable = t('当前环境不支持 Git 功能')
    })
    return
  }
  await probe()
}

/** 探测仓库 + 首次加载（探测失败 = 不是仓库 / 没装 git，都落成一句可读的不可用原因） */
async function probe(): Promise<void> {
  const dir = gitStore.dir
  if (!dir) return
  runInAction(() => {
    gitStore.loading = true
  })
  try {
    const info = await repoInfo(dir)
    runInAction(() => {
      gitStore.probed = true
      gitStore.repo = info
      gitStore.unavailable = info ? null : t('当前工作目录不是 Git 仓库')
      if (!info) gitStore.snapshot = null
    })
    if (info) await refreshStatus()
  } catch (e) {
    // 这里最可能是「未检测到 git」（Rust 侧给的就是一句可读文案）
    runInAction(() => {
      gitStore.probed = true
      gitStore.repo = null
      gitStore.unavailable = errorText(e)
    })
  } finally {
    runInAction(() => {
      gitStore.loading = false
    })
  }
}

/** 只刷状态（分支列表单独刷 —— 大多数操作不会改分支） */
export async function refreshStatus(): Promise<void> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return
  if (statusTaskId) stopTask(statusTaskId)
  const taskId = newTaskId('git_status')
  statusTaskId = taskId
  try {
    const snapshot = await fetchStatus(dir, taskId)
    if (taskId !== statusTaskId) return // 已被更新的一次刷新取代，丢弃本次结果
    acceptSnapshot(snapshot)
  } catch (e) {
    runInAction(() => {
      gitStore.error = errorText(e)
    })
  } finally {
    if (taskId === statusTaskId) statusTaskId = null
  }
}

/** 刷新分支列表（打开分支浮层时调） */
export async function refreshBranches(): Promise<void> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return
  try {
    const list = await fetchBranches(dir)
    runInAction(() => {
      gitStore.branches = list
    })
  } catch (e) {
    runInAction(() => {
      gitStore.error = errorText(e)
    })
  }
}

/** 面板打开 / 关闭（关闭时停止未完成的读操作，不做任何 IO） */
export function setPanelOpen(open: boolean): void {
  runInAction(() => {
    gitStore.open = open
  })
  if (!open && statusTaskId) {
    stopTask(statusTaskId)
    statusTaskId = null
  }
}

/** 窗口重新聚焦时调（用户在编辑器 / 终端里动过文件，切回来要看得见） */
export async function refreshOnFocus(): Promise<void> {
  if (!gitStore.open || !gitStore.repo) return
  await refreshStatus()
}

// ==================== 写操作 ====================

export async function stage(paths: string[]): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || paths.length === 0) return false
  const snapshot = await run('stage', () => invokeStage(dir, paths))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  return true
}

export async function unstage(paths: string[]): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || paths.length === 0) return false
  const snapshot = await run('unstage', () => invokeUnstage(dir, paths))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  return true
}

/**
 * 丢弃改动 —— **界面上唯一会丢数据的入口**，必须二次确认。
 *
 * 文案要区分两类（用户才知道自己在丢什么）：
 * - 已跟踪文件：改动**不可恢复**（git 语义如此）；
 * - 未跟踪文件：移入回收站（可恢复）。
 *
 * 返回是否真的丢了（确认框取消 / 被 `busy` 拦下都是 `false`）—— 调用方据此决定后续动作。
 */
export async function discard(paths: string[]): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || paths.length === 0) return false
  const ok = await MessagePrompt.propt(
    t('丢弃这些文件的改动？'),
    tpl(
      '共 $__count__ 个文件。已跟踪文件的改动丢弃后无法恢复；未跟踪文件会移入回收站。',
      { count: paths.length },
    ),
    { confirmText: t('丢弃'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const snapshot = await run('discard', () => invokeDiscard(dir, paths))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  return true
}

/**
 * 提交。
 *
 * `allowEmptyStage = false` 时若无已暂存内容，先问「是否全部暂存并提交」——
 * 这是 VS Code 的老行为，也是新用户最常撞的一堵墙。
 */
export async function commit(message: string): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  if (!message.trim()) {
    showToast(t('提交信息不能为空'))
    return false
  }

  const stagedCount = (gitStore.snapshot?.entries ?? []).filter(
    (e) => e.kind !== 'untracked' && e.x !== '.' && e.x !== '?',
  ).length
  if (stagedCount === 0) {
    const all = (gitStore.snapshot?.entries ?? []).map((e) => e.path)
    if (all.length === 0) {
      showToast(t('没有可提交的更改'))
      return false
    }
    const ok = await MessagePrompt.propt(
      t('暂存区为空'),
      tpl('当前没有已暂存的文件。是否把全部 $__count__ 个文件暂存后一起提交？', {
        count: all.length,
      }),
      { confirmText: t('全部暂存并提交'), cancelText: t('取消') },
    )
    if (!ok) return false
    const staged = await run('stage_all', () => invokeStage(dir, all))
    if (!staged) return false
    acceptSnapshot(staged)
  }

  const result = await run('commit', () => invokeCommit(dir, message))
  if (!result) return false
  runInAction(() => {
    gitStore.commitDraft = ''
  })
  showToast(
    result.summary
      ? tpl('已提交：$__summary__', { summary: result.summary })
      : t('已提交'),
  )
  await refreshStatus()
  return true
}

/** 切换 / 新建分支（脏工作区与目标冲突时 git 自己会拒绝，错误原样展示） */
export async function switchBranch(
  name: string,
  create: boolean,
  startPoint: string | null = null,
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const snapshot = await run('branch_switch', () =>
    invokeSwitchBranch(dir, name, create, startPoint),
  )
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  await refreshBranches()
  showToast(create ? tpl('已创建并切换到 $__name__', { name }) : tpl('已切换到 $__name__', { name }))
  return true
}

/** 分支名合法性（输入时即时校验，权威判定在 Rust） */
export function checkRefFormat(name: string): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir) return Promise.resolve(false)
  return invokeCheckRefFormat(dir, name).catch(() => false)
}

// ==================== 差异 ====================

/**
 * 取差异的两侧内容。**不缓存**：差异视图自己持有，关掉即弃。
 * 失败抛出（调用方在弹窗里显示错误行），不做 toast —— 差异弹窗自己有位置说清原因。
 */
export async function loadDiffSides(
  path: string,
  scope: GitDiffScope,
  origPath: string | null,
): Promise<GitDiffSides> {
  const dir = gitStore.dir
  if (!dir) throw new Error(t('当前工作目录不是 Git 仓库'))
  return invokeDiffSides(dir, path, scope, origPath, newTaskId('git_diff'))
}
