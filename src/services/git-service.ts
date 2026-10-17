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
 *    窗口重新激活时（面板关着也刷，见 `refreshOnFocus`）/ 会话活动后（工具调用结束 / 一轮对话
 *    结束，防抖 2s，见 `notifyWorkspaceActivity`）/ 用户点刷新；关闭面板本身不发请求；
 * 3. 读操作的取消走既有 `stop_task`：新的 status 起跑前先把上一次停掉（超大仓库连点刷新时有用）。
 *
 * ⚠️ 埋点红线：只报**动作 / 条数 / 结果**，不报仓库路径、分支名、提交信息正文（方案 §6）。
 */
import { runInAction } from 'mobx'
import {
  branches as fetchBranches,
  checkRefFormat as invokeCheckRefFormat,
  commit as invokeCommit,
  commitAmend as invokeCommitAmend,
  commitDetail as invokeCommitDetail,
  commitFileSides as invokeCommitFileSides,
  deleteBranch as invokeDeleteBranch,
  diffSides as invokeDiffSides,
  discard as invokeDiscard,
  initRepo as invokeInitRepo,
  isGitEnvAvailable,
  log as invokeLog,
  renameBranch as invokeRenameBranch,
  repoInfo,
  stage as invokeStage,
  status as fetchStatus,
  stopTask,
  switchBranch as invokeSwitchBranch,
  undoLastCommit as invokeUndoLastCommit,
  unstage as invokeUnstage,
} from '@/infrastructure/git'
import type {
  GitCommitDetail,
  GitCommitLogEntry,
  GitDiffScope,
  GitDiffSides,
  GitLogScope,
} from '@/domain/git'
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
    gitStore.notRepo = false
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
      // 「不是仓库」是个**可用状态**（面板会给出「初始化仓库」），与「没装 git / 出错了」不同
      gitStore.notRepo = !info
      gitStore.unavailable = info ? null : t('当前工作目录不是 Git 仓库')
      if (!info) gitStore.snapshot = null
    })
    if (info) await refreshStatus()
  } catch (e) {
    // 这里最可能是「未检测到 git」（Rust 侧给的就是一句可读文案）
    runInAction(() => {
      gitStore.probed = true
      gitStore.repo = null
      gitStore.notRepo = false
      gitStore.unavailable = errorText(e)
    })
  } finally {
    runInAction(() => {
      gitStore.loading = false
    })
  }
}

/**
 * 在当前工作目录初始化仓库（`git init`）——「不是仓库」空态里唯一出口。
 *
 * 成功后**直接接上探测的那套入参**（repo / snapshot），用户不必再去看一眼「为什么徽标还没出来」。
 */
export async function initRepo(): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir) return false
  const info = await run('init', () => invokeInitRepo(dir))
  if (!info) return false
  runInAction(() => {
    gitStore.repo = info
    gitStore.notRepo = false
    gitStore.unavailable = null
    gitStore.probed = true
  })
  showToast(t('已初始化仓库'))
  await refreshStatus()
  await refreshBranches()
  return true
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

/** 两次「窗口激活刷新」之间的最小间隔（毫秒）—— 频繁切窗时别反复叫醒 git */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500

/** 上一次窗口激活刷新的时刻 */
let lastFocusRefreshAt = 0

/**
 * 窗口重新激活时调（点任务栏 / 直接点窗口）—— 用户在编辑器 / 终端里动过文件，切回来要看得见。
 *
 * **不要求面板打开**：标题栏上的变更数徽标在面板关着时照样显示，只看 `open` 就会出现
 * 「明明改了 3 个文件、徽标还是 0」。节流兜住频繁切窗（每次都会跑一次 git status）。
 */
export async function refreshOnFocus(): Promise<void> {
  if (!gitStore.repo) return
  const now = Date.now()
  if (now - lastFocusRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return
  lastFocusRefreshAt = now
  await refreshStatus()
}

// ==================== 会话活动触发的自动刷新 ====================

/** 会话活动（工具调用结束 / 一轮对话结束）后的防抖窗口：把「连着调 10 个工具」压成一次刷新 */
const ACTIVITY_DEBOUNCE_MS = 2000

/** 待执行的防抖定时器（`null` = 没有排期） */
let activityTimer: ReturnType<typeof setTimeout> | null = null

/** 窗口是否处于激活状态（与 `GitEntry` 的 `focus` 监听同一口径：要的是 webview 真被激活） */
function isWindowActive(): boolean {
  return typeof document !== 'undefined' && document.hasFocus()
}

/**
 * 会话活动（每次工具调用结束 / 一轮对话结束）时调 —— 防抖 2s 后刷新一次该工作目录的状态。
 *
 * 三道前置（`dir` 必须是面板当前绑定的工作目录，且窗口处于激活状态）：后台会话 / 窗口在后台时
 * **不排期** —— 用户看不见徽标，白跑 git 没有意义（窗口切回来时 `refreshOnFocus` 会补一次）。
 * 调用方（`event-handler::scheduleGitRefresh`）已先按「当前选中的会话」过一道闸（见那里）。
 *
 * 到点前再判一次：2s 内用户可能把窗口切走 / 换了工作目录，那时这次刷新就该放弃。
 */
export function notifyWorkspaceActivity(dir: string | null): void {
  if (!dir || gitStore.dir !== dir || !gitStore.repo || !isWindowActive()) return
  if (activityTimer !== null) clearTimeout(activityTimer)
  activityTimer = setTimeout(() => {
    activityTimer = null
    if (gitStore.dir !== dir || !gitStore.repo || !isWindowActive()) return
    void refreshStatus()
  }, ACTIVITY_DEBOUNCE_MS)
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
 * `amend = true` 时走 `--amend`（把暂存内容并入**上一条**提交，或只改提交信息）——
 * 那种情况**不**走「暂存区为空就问要不要全暂存」那一支：amend 本来就允许没有新内容。
 *
 * `allowEmptyStage = false` 时若无已暂存内容，先问「是否全部暂存并提交」——
 * 这是 VS Code 的老行为，也是新用户最常撞的一堵墙。
 */
export async function commit(message: string, amend = false): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  if (!message.trim()) {
    showToast(t('提交信息不能为空'))
    return false
  }

  const stagedCount = (gitStore.snapshot?.entries ?? []).filter(
    (e) => e.kind !== 'untracked' && e.x !== '.' && e.x !== '?',
  ).length
  if (!amend && stagedCount === 0) {
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

  const result = await run(amend ? 'commit_amend' : 'commit', () =>
    amend ? invokeCommitAmend(dir, message) : invokeCommit(dir, message),
  )
  if (!result) return false
  runInAction(() => {
    gitStore.commitDraft = ''
    // hooks / 警告只出现在 stderr（正常提交为空）—— 丢掉它等于把「hook 动过什么」藏起来
    gitStore.hookOutput = result.stderr.trim() ? result.stderr.trim() : null
  })
  showToast(
    amend
      ? tpl('已修改上次提交：$__summary__', { summary: result.summary })
      : result.summary
        ? tpl('已提交：$__summary__', { summary: result.summary })
        : t('已提交'),
  )
  await refreshStatus()
  return true
}

/**
 * 撤销最后一次提交（`reset --soft`）：**改动全部留在暂存区**，不丢代码。
 *
 * 仍然要二次确认：它改写的是提交历史（别人已经拉走的那条会被当成被丢弃的分支尖端）。
 */
export async function undoLastCommit(): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const ok = await MessagePrompt.propt(
    t('撤销上次提交？'),
    t('这条提交会被撤掉，它的改动全部保留在暂存区（不会丢代码）。'),
    { confirmText: t('撤销'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const snapshot = await run('commit_undo', () => invokeUndoLastCommit(dir))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  await refreshBranches()
  showToast(t('已撤销上次提交，改动保留在暂存区'))
  return true
}

/**
 * 切换 / 新建 / **游离（detach）到某个分支**（脏工作区与目标冲突时 git 自己会拒绝，错误原样展示）。
 *
 * `detach` 专给**远程分支**用：`git switch origin/x` 会直接 fatal（git 只收本地分支名，
 * 退出码 128），只有 `--detach` 能落到它的提交上。切完 HEAD 不在任何分支上 —— 面板上那个
 * 「游离 HEAD」入口就是回分支的路，别把它做成不可点。
 */
export async function switchBranch(
  name: string,
  create: boolean,
  startPoint: string | null = null,
  detach = false,
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const snapshot = await run('branch_switch', () =>
    invokeSwitchBranch(dir, name, create, startPoint, detach),
  )
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  await refreshBranches()
  showToast(
    create
      ? tpl('已创建并切换到 $__name__', { name })
      : detach
        ? tpl('已游离到 $__name__（HEAD 不在任何分支上）', { name })
        : tpl('已切换到 $__name__', { name }),
  )
  return true
}

/**
 * 删除本地分支。`force = false` 时 git 会拦住未合并的分支 —— **不自动改成 `-D`**：
 * 用户点「删除」时要知道自己在丢什么。
 */
export async function removeBranch(name: string, force = false): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const ok = await MessagePrompt.propt(
    force ? t('强制删除分支？') : t('删除分支？'),
    force
      ? tpl('$__name__ 会被强制删除：即使它上面有未合并的提交。', { name })
      : tpl('$__name__ 会被删除；若它有未合并的提交，git 会拒绝。', { name }),
    { confirmText: t('删除'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const list = await run('branch_delete', () => invokeDeleteBranch(dir, name, force))
  if (!list) return false
  runInAction(() => {
    gitStore.branches = list
  })
  showToast(tpl('已删除分支 $__name__', { name }))
  return true
}

/**
 * 重命名分支（含当前分支）。
 *
 * 重命名后额外刷一次**状态**：改的是当前分支时，`snapshot.head.branch` 也跟着变了
 *（不刷就会出现「浮层里叫新名字、面板头还写着旧名字」）。
 */
export async function renameBranch(from: string, to: string): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const name = to.trim()
  if (!name || name === from) return false
  const list = await run('branch_rename', () => invokeRenameBranch(dir, from, name))
  if (!list) return false
  runInAction(() => {
    gitStore.branches = list
  })
  await refreshStatus()
  showToast(tpl('已重命名为 $__name__', { name }))
  return true
}

/** 分支名合法性（输入时即时校验，权威判定在 Rust） */
export function checkRefFormat(name: string): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir) return Promise.resolve(false)
  return invokeCheckRefFormat(dir, name).catch(() => false)
}

// ==================== 提交记录 ====================

/** 一页提交记录多少条（「加载更多」按它推进 skip；界面靠「拿回的是不是整页」判断还有没有） */
export const LOG_PAGE_SIZE = 50

/**
 * 提交图一页多少条 —— 比列表大得多。
 *
 * 「提交图」首页要装得下**各分支头**：50 条往往只覆盖当前分支最近的一串，看上去就是一条直线
 * （那正是用户要看的「分支关系」不出现的原因）。200 仍远低于 Rust 侧 `MAX_LIMIT = 500`。
 */
export const GRAPH_PAGE_SIZE = 200

/**
 * 取一页提交记录（`skip` = 已经拿过多少条；`scope` = head / all）。
 *
 * 四条口径：
 * - **不进 `busy`**：读操作不拦写操作（看一眼历史不该把提交按钮锁住）；
 * - **不写 store**：弹窗自己持有这份列表，关掉即弃 —— 缓存会让「刚提交完再打开」显示旧列表
 *   （与差异正文同一取舍）；
 * - **失败抛出**（不 toast）：弹窗自己有位置说清原因，弹窗还没开就给 toast 更没有落点；
 * - **分页大小按范围给**（列表 50 / 提交图 200）—— ⚠️ 「还有没有下一页」的判据是
 *   「拿回的是不是整页」，所以页大小必须与 `scope` 一一对应，不能用当前列表长度去推。
 */
export async function loadCommits(
  skip: number,
  scope: GitLogScope = 'head',
): Promise<GitCommitLogEntry[]> {
  const dir = gitStore.dir
  if (!dir) throw new Error(t('当前工作目录不是 Git 仓库'))
  const limit = scope === 'all' ? GRAPH_PAGE_SIZE : LOG_PAGE_SIZE
  return invokeLog(dir, skip, limit, scope, newTaskId(`git_log_${scope}`))
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

// ==================== 提交详情 ====================

/**
 * 取一个提交的详情。与差异正文同一取舍：**不缓存、不进 `busy`**（看一眼历史不该锁住写操作）；
 * 失败抛出 —— 弹窗自己有位置说清原因。
 */
export async function loadCommitDetail(oid: string): Promise<GitCommitDetail> {
  const dir = gitStore.dir
  if (!dir) throw new Error(t('当前工作目录不是 Git 仓库'))
  return invokeCommitDetail(dir, oid)
}

/** 某个提交里一条路径的两侧内容（按需取：一次拉整个提交的 diff，大提交上是几十 MB） */
export async function loadCommitFileSides(
  oid: string,
  path: string,
  origPath: string | null,
): Promise<GitDiffSides> {
  const dir = gitStore.dir
  if (!dir) throw new Error(t('当前工作目录不是 Git 仓库'))
  return invokeCommitFileSides(dir, oid, path, origPath, newTaskId('git_commit_diff'))
}
