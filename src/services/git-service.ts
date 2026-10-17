/**
 * 「源代码管理」面板的编排层：探测 / 刷新时机 / 操作串行 / 确认与提示 / 埋点。
 * 数据经 @/infrastructure/git，口径判定用 @/domain/git 的纯函数。
 *
 * 写操作一次只允许一个（busy 非空即拒）；读操作不进 busy。
 * 刷新时机：探测 / 打开面板 / 操作后 / 窗口激活 / 会话活动后（防抖 2s）/ 用户手点。
 * 埋点只报动作 / 条数 / 结果，不报路径、分支名、提交信息。
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
  fetchRemote as invokeFetch,
  initRepo as invokeInitRepo,
  isGitEnvAvailable,
  log as invokeLog,
  numstat as invokeNumstat,
  pullRemote as invokePull,
  pushRemote as invokePush,
  remotes as fetchRemotes,
  renameBranch as invokeRenameBranch,
  repoInfo,
  stage as invokeStage,
  status as fetchStatus,
  stopTask,
  switchBranch as invokeSwitchBranch,
  testRemote as invokeTestRemote,
  undoLastCommit as invokeUndoLastCommit,
  unstage as invokeUnstage,
} from '@/infrastructure/git'
import type {
  GitCommitDetail,
  GitCommitLogEntry,
  GitDiffScope,
  GitDiffSides,
  GitLogScope,
  GitSyncResult,
} from '@/domain/git'
import { gitStore } from '@/ui/store/gitStore'
import { MessageBox as MessagePrompt } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { t, tpl } from '@/ui/i18n'
import { track } from '@/utils/telemetry'

/** 新建任务 id */
function newTaskId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** 进行中的 status 的任务 id —— 起新的之前先把它停掉 */
let statusTaskId: string | null = null
/** 进行中的行数统计的任务 id（同理：新的一次先停掉旧的） */
let statsTaskId: string | null = null

/** 进行中的网络操作任务 id：面板关掉时也停掉（网络超时 10 分钟） */
let syncTaskId: string | null = null

/** 错误 → 一行文案（Rust 侧已拼好 stderr） */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.trim() || t('操作失败')
}

/** 统一收口：置 busy → 跑 → 清 busy → 失败落 error（+ 持久弹窗） */
async function run<T>(
  label: string,
  fn: () => Promise<T>,
  /**
   * `dialog: false` = 调用方**自己就地展示**错误（如同步浮层），不再弹窗 ——
   * 两层信息重复，而且弹窗会盖住那个浮层。
   */
  opts: { dialog?: boolean } = {},
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
      // ⚠️ 不用 toast：git 的报错是多行 stderr，几秒就消失的提示读不完也复制不了
      if (opts.dialog !== false) gitStore.errorBox = { op: label, text }
    })
    track('git.op', { op: label, ok: false, ms: Date.now() - started })
    // 失败后立刻回读：列表过期是写操作失败的头号原因（面板拿着旧快照，git 说 did not match）
    void refreshStatus()
    return null
  } finally {
    runInAction(() => {
      gitStore.busy = null
    })
  }
}

/** 快照落地（写操作与刷新共用） */
function acceptSnapshot(snapshot: Awaited<ReturnType<typeof fetchStatus>>): void {
  runInAction(() => {
    gitStore.snapshot = snapshot
    gitStore.error = null
  })
}

// ==================== 探测与刷新 ====================

/** 切换工作目录（会话切换 / 选目录时调）；目录没变则不重复探测。 */
export async function syncWorkspace(dir: string | null): Promise<void> {
  if (gitStore.dir === dir && gitStore.probed) return
  runInAction(() => {
    gitStore.dir = dir
    gitStore.probed = false
    gitStore.repo = null
    gitStore.unavailable = null
    gitStore.snapshot = null
    gitStore.branches = []
    gitStore.remotes = []
    gitStore.syncOutput = null
    gitStore.stats = null
    gitStore.error = null
    gitStore.errorBox = null
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

/** 探测仓库 + 首次加载（探测失败 = 不是仓库 / 没装 git，都落成不可用原因） */
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
      // 不是仓库 / 没装 git / 出错：`repo` 为 null，入口自然不出现（见 GitEntry 显隐口径）
      gitStore.unavailable = info ? null : t('当前工作目录不是 Git 仓库')
      if (!info) gitStore.snapshot = null
    })
    if (info) await refreshStatus()
    if (info) await refreshRemotes()
  } catch (e) {
    // 这里最可能是「未检测到 git」
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

/**
 * 在当前工作目录初始化仓库。
 *
 * 界面当前**不提供入口**（图标只在已有 `.git` 时出现，见 `GitEntry`），保留给命令面板 / 未来入口；
 * 用户在终端里 `git init` 后由 [`reprobeIfMissing`] 自动接上。
 */
export async function initRepo(): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir) return false
  const info = await run('init', () => invokeInitRepo(dir))
  if (!info) return false
  runInAction(() => {
    gitStore.repo = info
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
    runInAction(() => {
      // 只落快照，**不清 error**：状态回读是读操作，不该把「上一次写操作为什么失败」抹掉
      //（`run()` 失败后会立刻回读一次，清掉就等于弹窗之外再也找不到原因）
      gitStore.snapshot = snapshot
    })
    // 行数统计只在面板打开时才有用（徽标只数文件）：它比 status 贵，关着不跑
    if (gitStore.open) void refreshStats()
  } catch (e) {
    runInAction(() => {
      gitStore.error = errorText(e)
    })
  } finally {
    if (taskId === statusTaskId) statusTaskId = null
  }
}

/**
 * 取一次逐文件行数统计（面板里的「+12 −3」与顶部合计）。
 *
 * **只在面板打开时跑**：它比 `status` 贵（两次 `git diff --numstat` + 一次 `ls-files`，未跟踪文件
 * 还要逐个读来数行），而面板关着时徽标只需要文件数。失败不弹窗：行数是辅助信息，不该因为
 * 它把面板打断（错误落在 `error` 上，与其它旁路读取一致）。
 */
export async function refreshStats(): Promise<void> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return
  if (!gitStore.open) {
    runInAction(() => {
      gitStore.stats = null
    })
    return
  }
  if (statsTaskId) stopTask(statsTaskId)
  const taskId = newTaskId('git_numstat')
  statsTaskId = taskId
  try {
    const report = await invokeNumstat(dir, taskId)
    if (taskId !== statsTaskId) return // 已被更新的一次取代，丢弃本次结果
    runInAction(() => {
      gitStore.stats = report
    })
  } catch (e) {
    runInAction(() => {
      gitStore.error = errorText(e)
    })
  } finally {
    if (taskId === statsTaskId) statsTaskId = null
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

/** 刷新远程列表。旁路读取：失败当「没有远程」，不打断面板 */
export async function refreshRemotes(): Promise<void> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return
  let list: Awaited<ReturnType<typeof fetchRemotes>> = []
  try {
    list = await fetchRemotes(dir)
  } catch {
    list = []
  }
  runInAction(() => {
    gitStore.remotes = list
  })
}

export function setPanelOpen(open: boolean): void {
  runInAction(() => {
    gitStore.open = open
  })
  if (!open && statusTaskId) {
    stopTask(statusTaskId)
    statusTaskId = null
  }
  if (!open && statsTaskId) {
    stopTask(statsTaskId)
    statsTaskId = null
  }
  // 网络操作不随面板关闭丢结果，但别让它在后台白等到超时
  if (!open) cancelSync()
}

/**
 * 取消进行中的网络操作。只是发起中断：命令壳会等子进程真正退出后才报「已取消」。
 */
export function cancelSync(): void {
  if (!syncTaskId) return
  stopTask(syncTaskId)
  syncTaskId = null
}

/** 两次窗口激活刷新的最小间隔（ms），频繁切窗时别反复叫醒 git */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500

/** 上一次窗口激活刷新的时刻 */
let lastFocusRefreshAt = 0

/** 「还不是仓库」时重新探测的最小间隔：用户在终端里 `git init` 之后入口要能自己出现 */
const REPROBE_MIN_INTERVAL_MS = 5000
let lastReprobeAt = 0

/**
 * 重新探测「现在是不是仓库了」。
 *
 * 入口只在**已有 `.git`** 时出现（见 `GitEntry`），所以「从没有变有」必须靠这一步：
 * 用户（或 AI）在终端里 `git init` 之后，下一次窗口激活 / 会话活动就能看到图标。
 * 代价是没装 git / 一直不是仓库时也会反复问一次 —— 5s 节流把这笔开销压在一次次 `rev-parse`。
 */
async function reprobeIfMissing(): Promise<void> {
  const now = Date.now()
  if (now - lastReprobeAt < REPROBE_MIN_INTERVAL_MS) return
  lastReprobeAt = now
  await probe()
}

/**
 * 窗口重新激活时调：用户在编辑器 / 终端里动过文件，切回来要看得见。
 * 不要求面板打开（标题栏徽标关着也显示）。
 */
export async function refreshOnFocus(): Promise<void> {
  if (!gitStore.dir) return
  const now = Date.now()
  if (now - lastFocusRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return
  lastFocusRefreshAt = now
  if (!gitStore.repo) {
    await reprobeIfMissing()
    return
  }
  await refreshStatus()
}

// ==================== 会话活动触发的自动刷新 ====================

/** 会话活动后的防抖窗口：把「连着调 10 个工具」压成一次刷新 */
const ACTIVITY_DEBOUNCE_MS = 2000

/** 待执行的防抖定时器（`null` = 没有排期） */
let activityTimer: ReturnType<typeof setTimeout> | null = null

/** 窗口是否处于激活状态（要的是 webview 真被激活） */
function isWindowActive(): boolean {
  return typeof document !== 'undefined' && document.hasFocus()
}

/**
 * 会话活动后防抖 2s 刷新一次状态。工作目录不匹配 / 窗口在后台 / 不是仓库均不排期；
 * 到点前再判一次（2s 内窗口可能切走或换了目录）。
 */
export function notifyWorkspaceActivity(dir: string | null): void {
  if (!dir || gitStore.dir !== dir || !isWindowActive()) return
  if (activityTimer !== null) clearTimeout(activityTimer)
  activityTimer = setTimeout(() => {
    activityTimer = null
    if (gitStore.dir !== dir || !isWindowActive()) return
    // AI 可能刚在这个目录里 `git init` 了：没有仓库时改成重新探测，否则入口永远不会出现
    if (!gitStore.repo) {
      void reprobeIfMissing()
      return
    }
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
 * 丢弃改动 —— 界面上唯一会丢数据的入口，必须二次确认（已跟踪不可恢复，未跟踪进回收站）。
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
 * 提交。amend 时走 --amend（不要求暂存区非空）；否则暂存区空时先问「全部暂存并提交」。
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
    // hooks / 警告只在 stderr：丢掉它等于把「hook 动过什么」藏起来
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

/** 撤销最后一次提交（reset --soft）：改动留在暂存区，但仍然二确（改写了提交历史）。 */
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
 * 切换 / 新建 / 游离到某个分支。detach 专给远程分支（git switch origin/x 会 fatal）。
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

/** 删除本地分支；不一定自动改成 -D（用户要知道自己在丢什么） */
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
 * 重命名分支。额外刷状态：改的是当前分支时 snapshot.head.branch 也变了。
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

// ==================== 远程（凭据策略 = SSH） ====================

/**
 * 一次网络操作的公共流程：busy 串行 → 落输出 → toast → 刷新状态与分支。
 * remote 由调用方显式给出（两边都猜会出现「界面说 origin、实际跑了别的」）。
 * 默认**不弹错误窗**：主调用方是同步浮层，它会把失败原文留在原地（见 `run` 的 `dialog`）。
 */
async function syncAction(
  label: string,
  call: (dir: string, remote: string | null, taskId: string) => Promise<GitSyncResult>,
  remote: string | null,
  success: (result: GitSyncResult) => string,
  dialog = false,
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const taskId = newTaskId(`git_${label}`)
  syncTaskId = taskId
  let result: GitSyncResult | null = null
  try {
    result = await run(label, () => call(dir, remote, taskId), { dialog })
  } finally {
    if (syncTaskId === taskId) syncTaskId = null
  }
  if (!result) return false
  const output = result.output.trim()
  runInAction(() => {
    gitStore.syncOutput = output || null
  })
  showToast(success(result))
  await refreshStatus()
  await refreshBranches()
  return true
}

/** 成功文案（浮层与一键同步共用，避免两处文案跑偏） */
const pullDone = (r: GitSyncResult): string =>
  tpl('已从 $__remote__ 拉取', { remote: r.remote })
const pushDone = (r: GitSyncResult): string =>
  tpl('已推送到 $__remote__', { remote: r.remote })

/** fetch：只更新远程跟踪分支，不动工作区 */
export function fetchRemote(remote: string | null = null): Promise<boolean> {
  return syncAction('fetch', invokeFetch, remote, (r) =>
    tpl('已从 $__remote__ 获取更新', { remote: r.remote }),
  )
}

/** pull --ff-only：快进不了就失败，不生成 merge 提交 */
export function pullRemote(remote: string | null = null): Promise<boolean> {
  return syncAction('pull', invokePull, remote, pullDone)
}

/** push（无上游时 Rust 侧自动 -u）；不做强推也不二次确认 */
export function pushRemote(remote: string | null = null): Promise<boolean> {
  return syncAction('push', invokePush, remote, pushDone)
}

/**
 * 从 upstream（`origin/main`）反推远程名。
 * ⚠️ 远程名本身允许含 `/`，所以先按已加载的远程列表取**最长前缀**，取不到才退回第一段。
 */
function remoteOf(upstream: string | null): string | null {
  if (!upstream) return null
  const names = gitStore.remotes
    .map((r) => r.name)
    .sort((a, b) => b.length - a.length)
  const hit = names.find((n) => upstream.startsWith(`${n}/`))
  if (hit) return hit
  const slash = upstream.indexOf('/')
  return slash > 0 ? upstream.slice(0, slash) : null
}

/**
 * 一键同步（面板头部的落差按钮）：**先拉取（--ff-only）再推送**。
 *
 * 顺序不能反：分叉时先推会被远程拒（non-fast-forward），用户还得再点一次；
 * 而 `--ff-only` 拉取在「本地已是最新」时只是无害的 no-op。任一步失败即停 ——
 * 后面的动作是建立在前面成功的前提上的。
 */
export async function syncNow(): Promise<boolean> {
  const head = gitStore.snapshot?.head
  if (!head?.branch) return false
  const remote = remoteOf(head.upstream)
  // 面板头的一键同步没有「原地」可展示错误：失败必须弹窗（dialog = true）
  if (
    head.behind > 0 &&
    !(await syncAction('pull', invokePull, remote, pullDone, true))
  )
    return false
  // 拉取后 ahead 可能变了（快进带进来的提交本来就在远程上）→ 以新快照为准
  const after = gitStore.snapshot?.head
  if (
    (after?.ahead ?? 0) > 0 &&
    !(await syncAction('push', invokePush, remote, pushDone, true))
  )
    return false
  return true
}

/**
 * 测试远程连接（ls-remote）。不进 busy、不写 store：诊断失败由调用方原地显示。
 */
export async function testRemote(remote: string | null = null): Promise<void> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) throw new Error(t('当前工作目录不是 Git 仓库'))
  await invokeTestRemote(dir, remote, newTaskId('git_remote_test'))
}

// ==================== 提交记录 ====================

/** 一页提交记录条数（加载更多按它推进 skip） */
export const LOG_PAGE_SIZE = 50

/**
 * 提交图一页条数（远大于列表）：首页要装得下各分支头，50 条往往只有一条直线。
 */
export const GRAPH_PAGE_SIZE = 200

/**
 * 取一页提交记录。不进 busy、不写 store、失败抛出（弹窗自有位置说清原因）；
 * 页大小按 scope 给，因为「还有没有下一页」靠「拿回的是不是整页」判定。
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
 * 取差异两侧内容。不缓存，失败抛出（弹窗里显示错误行）。
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
 * 取提交详情。与差异正文同一取舍：不缓存、不进 busy，失败抛出。
 */
export async function loadCommitDetail(oid: string): Promise<GitCommitDetail> {
  const dir = gitStore.dir
  if (!dir) throw new Error(t('当前工作目录不是 Git 仓库'))
  return invokeCommitDetail(dir, oid)
}

/** 某提交里一条路径的两侧内容（按需取：整个提交的 diff 可能几十 MB） */
export async function loadCommitFileSides(
  oid: string,
  path: string,
  origPath: string | null,
): Promise<GitDiffSides> {
  const dir = gitStore.dir
  if (!dir) throw new Error(t('当前工作目录不是 Git 仓库'))
  return invokeCommitFileSides(dir, oid, path, origPath, newTaskId('git_commit_diff'))
}
