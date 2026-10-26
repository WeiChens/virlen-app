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
  merge as invokeMerge,
  mergeAbort as invokeMergeAbort,
  mergeState as invokeMergeState,
  numstat as invokeNumstat,
  pick as invokePick,
  pickAbort as invokePickAbort,
  pickResume as invokePickResume,
  pickState as invokePickState,
  pullRemote as invokePull,
  pushRemote as invokePush,
  remotes as fetchRemotes,
  renameBranch as invokeRenameBranch,
  repoInfo,
  resetPreview as invokeResetPreview,
  resetSoft as invokeResetSoft,
  stage as invokeStage,
  status as fetchStatus,
  stashApply as invokeStashApply,
  stashDrop as invokeStashDrop,
  stashPush as invokeStashPush,
  stashRestore as invokeStashRestore,
  stashes as fetchStashes,
  stopTask,
  switchBranch as invokeSwitchBranch,
  testRemote as invokeTestRemote,
  undoLastCommit as invokeUndoLastCommit,
  unstage as invokeUnstage,
} from '@/infrastructure/git'
import {
  stashSummary,
  type GitCommitDetail,
  type GitCommitLogEntry,
  type GitDiffScope,
  type GitDiffSides,
  type GitLogScope,
  type GitPickKind,
  type GitPickState,
  type GitSyncResult,
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

/** 进行中的网络操作任务 id：被 `cancelSync` / 新的同步取代而停止（关面板不停） */
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
  opts: {
    /**
     * 这次调用是否已被取消 / 取代（取消是**我们主动 kill 的 git**，不是失败）。
     * 在 catch 里判：为 `true` 时**不写 error、不弹窗、不回读** —— 否则面板会长期挂着
     * 「git 操作已取消」（`refreshStatus` 成功时刻意不清 error，见那里的注释）。
     */
    stale?: () => boolean
  } = {},
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
    if (opts.stale?.()) {
      track('git.op', { op: label, ok: false, ms: Date.now() - started })
      return null
    }
    const text = errorText(e)
    runInAction(() => {
      gitStore.error = text
      // ⚠️ 不用 toast：git 的报错是多行 stderr，几秒就消失的提示读不完也复制不了
      gitStore.errorBox = { op: label, text }
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
    gitStore.stashes = []
    gitStore.lastDropped = null
    gitStore.syncOutput = null
    gitStore.stats = null
    // 换仓库了：上一个仓库的「挑选中 / 还原中」不能跟过来（下一次 refreshStatus 会重取）
    gitStore.pick = null
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
    // 挑选 / 还原的进行中状态跟着快照一起刷：任意一次刷新之后，面板顶部的
    // 「继续 / 中止」都不会拄着上一次动作的旧结论（代价是两条 rev-parse）
    if (gitStore.open) void loadPickState()
  } catch (e) {
    // 被新的一次刷新取代 / 面板关掉：旧那次是被我们 `stopTask` 取消的（Rust 回
    // 「git 操作已取消」），**不是错误**。成功路径有同一条对账，失败路径同样不能漏
    if (taskId !== statusTaskId) return
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
    // 同 `refreshStatus`：被取代 / 面板关掉后的取消不算失败
    if (taskId !== statsTaskId) return
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
  // ⚠️ 收起气泡**不中断**任何进行中的 git 调用：用户点完提交 / 推送后随手点空白处是常态，
  //    那次操作必须跑完（结果落在 store 与 toast 上，不需要面板在场）。中断只走显式
  //    调用 `cancelSync`（同步入口拆成菜单项后暂时没有界面按钮）或下一次刷新取代上一次（taskId 对账）。
}

/**
 * 取消进行中的网络操作。只是发起中断：命令壳会等子进程真正退出后才报「已取消」。
 * 同步入口现在是「更多」里的三个直达菜单项，没有取消按钮 —— 保留给服务层与用例。
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
  // index 变了：行数按**段**存放（staged / worktree），不重取的话行内会去旧的那一段里找
  // ——找不到就不画数字（实测反馈：全部取消暂存后切回「更改」，+N −M 全没了）
  void refreshStats()
  return true
}

export async function unstage(paths: string[]): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || paths.length === 0) return false
  const snapshot = await run('unstage', () => invokeUnstage(dir, paths))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  // 同上：文件从 staged 段跳到 worktree 段，统计必须重取
  void refreshStats()
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
  // 工作区文件被改写 / 删掉了：行内数字必须跟着重取（否则还挂着丢弃前的 +N −M）
  void refreshStats()
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

  const snapshotEntries = gitStore.snapshot?.entries ?? []
  const stagedCount = snapshotEntries.filter(
    (e) => e.kind !== 'untracked' && e.x !== '.' && e.x !== '?',
  ).length
  if (!amend && stagedCount === 0) {
    // ⚠️ rename / copy 的旧路径必须一起传：`git add <新路径>` 只记录新文件，旧路径的删除
    //    还留在工作区 → 提交后「改名」会变成「新增 + 旧文件还在」（与 stash 的同一条口径）。
    const all = [
      ...new Set(
        snapshotEntries.flatMap((e) => (e.orig_path ? [e.path, e.orig_path] : [e.path])),
      ),
    ]
    if (all.length === 0) {
      showToast(t('没有可提交的更改'))
      return false
    }
    // 快照被截断时「全部暂存」只涵盖前 5000 条 —— 必须当场说清，不能让人以为提了全部
    const truncatedHint =
      gitStore.snapshot?.truncated === true
        ? `\n${t('变更过多，仅显示前 5000 条（请先处理未跟踪目录或补 .gitignore）')}`
        : ''
    const ok = await MessagePrompt.propt(
      t('暂存区为空'),
      tpl('当前没有已暂存的文件。是否把全部 $__count__ 个文件暂存后一起提交？', {
        count: snapshotEntries.length,
      }) + truncatedHint,
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
  // 撤掉的改动全进了暂存区：统计的段归属整体换了，不重取就看不到数字
  void refreshStats()
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

// ==================== 合并（merge） ====================

/** 是否处于「合并中」（有未解决的冲突）。读操作：不进 busy */
export async function loadMergeState(): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  return invokeMergeState(dir).catch(() => false)
}

/**
 * 把某个分支合并到当前 HEAD。
 *
 * ⚠️ 冲突时 git 退出码 1，但**不是「什么都没发生」**：工作区已留下冲突标记、仓库进入
 * 「合并中」状态。`run()` 默认弹错误窗，git 的 `CONFLICT` 清单会原样落在里面（读不完也能复制），
 * 同时 `refreshStatus` 把它们列进面板的「冲突」段。
 */
export async function mergeBranch(name: string, noFf = false): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const result = await run('merge', () => invokeMerge(dir, name, noFf))
  // 成功或冲突：两种都可能有新提交 / 新冲突落进快照 —— 失败路径的 `run()` 已自己回读过状态
  if (!result) return false
  acceptSnapshot(result.snapshot)
  // 合并会改写工作区（冲突时还多出标记）：行数统计必须重取，否则行内还挂着合并前的 +N −M
  void refreshStats()
  showToast(
    result.up_to_date
      ? tpl('$__name__ 已经在当前分支里了，无需合并', { name })
      : result.fast_forward
        ? tpl('已快进合并 $__name__', { name })
        : tpl('已合并 $__name__（生成了合并提交）', { name }),
  )
  await refreshBranches()
  return true
}

/** 中止进行中的合并（回到合并前）。⚠️ 会丢掉冲突解决到一半的编辑 → 二次确认 */
export async function abortMerge(): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const ok = await MessagePrompt.propt(
    t('中止这次合并？'),
    t('工作区会回到合并之前：合并带入的改动与冲突标记都会被撤掉。'),
    { confirmText: t('中止合并'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const snapshot = await run('merge_abort', () => invokeMergeAbort(dir))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  void refreshStats()
  showToast(t('已中止合并'))
  return true
}

// ==================== 重置 / 挑选 / 还原 ====================

/**
 * 未了结的 cherry-pick / revert（读）—— 结果落到 store，面板顶部据它给「继续 / 中止」两条出路。
 *
 * 刷新时机与 `loadMergeState` 同：面板打开 / 窗口激活 / 每次动作之后。外部终端里的 git
 * 造成的漂移在下一次刷新时对齐（与合并中同一口径，不另起一套轮询）。
 */
export async function loadPickState(): Promise<GitPickState | null> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return null
  const state = await invokePickState(dir).catch((): null => null)
  runInAction(() => {
    gitStore.pick = state
  })
  return state
}

/**
 * 把当前分支重置到某笔提交（`reset --soft`：**改动全留在暂存区**）。
 *
 * 先预览再动手：不在 HEAD 祖先链上的提交**不给做** —— 那是「把当前分支挪到一段无关历史」，
 * 只能在终端里显式操作。这一步拦在界面上（而非靠 git 报错）才能说清「为什么不能」。
 */
export async function resetToCommit(
  oid: string,
  subject: string,
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const preview = await run('reset_preview', () =>
    invokeResetPreview(dir, oid),
  )
  if (!preview) return false
  if (!preview.ancestor) {
    void MessagePrompt.info(
      t('这笔提交不在当前分支的历史上'),
      t(
        '只有当前分支的祖先提交才能作为重置目标：否则等于把当前分支挪到一段无关历史上。',
      ),
    )
    return false
  }
  if (preview.commits === 0) {
    void MessagePrompt.info(
      t('无需重置'),
      t('当前分支已经在这笔提交上。'),
    )
    return false
  }
  const ok = await MessagePrompt.propt(
    t('重置到这笔提交？'),
    tpl(
      '当前分支会退到「$__subject__」，之后的 $__count__ 条提交被撤掉；它们的改动全部保留在暂存区（不会丢代码）。',
      { subject, count: preview.commits },
    ),
    { confirmText: t('重置'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const snapshot = await run('reset_soft', () => invokeResetSoft(dir, oid))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  // 工作区被改写（撤掉的提交带来的改动进了暂存区）→ 行数统计必须重取
  void refreshStats()
  void refreshBranches()
  showToast(tpl('已重置到「$__subject__」，改动保留在暂存区', { subject }))
  return true
}

/**
 * 挑选（cherry-pick）/ 还原（revert）一条提交。两种动作都**写历史**（生成新提交）→ 都先二确。
 *
 * ⚠️ 冲突时 `run()` 弹的错误窗里带着 git 的 `CONFLICT` 清单；此时仓库已进入「挑选中 / 还原中」，
 * 必须**立刻回读状态**，面板顶部才会出现「继续 / 中止」两条出路（否则冲突解到一半的用户只剩终端）。
 */
export async function pickCommit(
  kind: GitPickKind,
  oid: string,
  subject: string,
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const isPick = kind === 'cherry-pick'
  const ok = await MessagePrompt.propt(
    isPick ? t('挑选这条提交到当前分支？') : t('还原这条提交？'),
    isPick
      ? tpl('会把「$__subject__」的改动作为一条新提交搬到当前分支。', {
          subject,
        })
      : tpl('会生成一条新提交，把「$__subject__」的改动反向撤销。', {
          subject,
        }),
    { confirmText: isPick ? t('挑选') : t('还原'), cancelText: t('取消') },
  )
  if (!ok) return false
  const result = await run('pick', () => invokePick(dir, kind, oid))
  // 冲突时 `run()` 失败分支会自己回读一次状态（→ refreshStatus → loadPickState），
  // 面板顶部的「继续 / 中止」就是这么出现的；这里不重复发一次 IPC
  if (!result) return false
  acceptSnapshot(result.snapshot)
  void refreshStats()
  void refreshBranches()
  showToast(
    isPick
      ? tpl('已挑选「$__subject__」', { subject })
      : tpl('已还原「$__subject__」', { subject }),
  )
  return true
}

/** 继续进行中的挑选 / 还原（冲突已解决并**暂存**，否则 git 会拒并原样带回原因） */
export async function resumePick(kind: GitPickKind): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const snapshot = await run('pick_resume', () => invokePickResume(dir, kind))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  runInAction(() => {
    gitStore.pick = null
  })
  void refreshStats()
  void refreshBranches()
  showToast(kind === 'cherry-pick' ? t('已继续挑选') : t('已继续还原'))
  return true
}

/** 中止进行中的挑选 / 还原。⚠️ 会丢掉冲突解决到一半的编辑 → 二确 */
export async function abortPick(kind: GitPickKind): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const ok = await MessagePrompt.propt(
    kind === 'cherry-pick' ? t('中止这次挑选？') : t('中止这次还原？'),
    t('工作区会回到动作之前：已解决的冲突与带入的改动都会被撤掉。'),
    { confirmText: t('中止'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const snapshot = await run('pick_abort', () => invokePickAbort(dir, kind))
  if (!snapshot) return false
  acceptSnapshot(snapshot)
  runInAction(() => {
    gitStore.pick = null
  })
  void refreshStats()
  showToast(kind === 'cherry-pick' ? t('已中止挑选') : t('已中止还原'))
  return true
}

// ==================== 远程（凭据策略 = SSH） ====================

/**
 * 一次网络操作的公共流程：busy 串行 → 落输出 → toast → 刷新状态与分支。
 * remote 由调用方显式给出（两边都猜会出现「界面说 origin、实际跑了别的」）；传 `null` = 交给
 * Rust `pick`（origin → 唯一一个 → 都不是就报错，多个远程不猜）。
 * 失败一律走持久错误窗：调用方是「更多」菜单，点完菜单就收了，没有原位可以读多行 stderr。
 */
async function syncAction(
  label: string,
  call: (dir: string, remote: string | null, taskId: string) => Promise<GitSyncResult>,
  remote: string | null,
  success: (result: GitSyncResult) => string,
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const taskId = newTaskId(`git_${label}`)
  syncTaskId = taskId
  let result: GitSyncResult | null = null
  try {
    result = await run(label, () => call(dir, remote, taskId), {
      // `cancelSync()` 会把 `syncTaskId` 置空，再次发起会换成新 id：
      // 两种都说明「这一次的失败是我自己叫停的」
      stale: () => syncTaskId !== taskId,
    })
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

/** 成功文案（三个远程菜单项与一键同步共用，避免两处文案跑偏） */
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
  if (
    head.behind > 0 &&
    !(await syncAction('pull', invokePull, remote, pullDone))
  )
    return false
  // 拉取后 ahead 可能变了（快进带进来的提交本来就在远程上）→ 以新快照为准
  const after = gitStore.snapshot?.head
  if (
    (after?.ahead ?? 0) > 0 &&
    !(await syncAction('push', invokePush, remote, pushDone))
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

// ==================== 贮藏（stash） ====================

/** 取贮藏列表（浮层打开时调）。失败落 error、不弹窗 —— 打开浮层就弹错误窗太吵 */
export async function refreshStashes(): Promise<void> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return
  try {
    const list = await fetchStashes(dir)
    runInAction(() => {
      gitStore.stashes = list
    })
  } catch (e) {
    runInAction(() => {
      gitStore.error = errorText(e)
    })
  }
}

/**
 * 新建贮藏。
 *
 * 无改动 / 无提交 / 有冲突三种情况都由 Rust 侧拒绝（`git stash push` 在「没东西可贮藏」时
 * 退出码是 **0**，前端不能拿它当成功）；这里不重复判一遍，免得两处口径漂移。
 *
 * `paths` = 只贮藏选中的文件（空数组 = 全部）：`git stash push -- <路径>` 只收这些路径的改动，
 * 其余留在工作区。⚠️ 空数组在这里是「全部」而不是「什么都没选」——「一个都没选」必须由界面
 * 在调用前拦住（否则会变成「全选贮藏」）。
 */
export async function createStash(
  message: string,
  includeUntracked: boolean,
  keepIndex: boolean,
  paths: string[] = [],
): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const result = await run('stash_push', () =>
    invokeStashPush(dir, message, includeUntracked, keepIndex, paths),
  )
  if (!result) return false
  runInAction(() => {
    gitStore.snapshot = result.snapshot
    gitStore.stashes = result.stashes
  })
  // 工作区变了：行数统计（`+N −M`）跟着重取（面板关着时 `refreshStats` 自己会跳过）
  void refreshStats()
  showToast(paths.length > 0 ? t('已贮藏选中的文件') : t('已贮藏当前更改'))
  return true
}

/**
 * 应用（`pop = false`，条目保留）或应用并删除（`pop = true`）。
 *
 * ⚠️ 应用失败**不等于什么都没发生**：工作区有同类改动时 git 会 `Aborting`（工作区不动），
 * 但内容真冲突时退出码 1 且**工作区已经留下冲突标记** —— 那种情况必须说清，否则用户以为
 * 「什么都没变」，接着去提交，就把冲突标记一起提交了。
 */
export async function applyStash(oid: string, pop: boolean): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const result = await run(pop ? 'stash_pop' : 'stash_apply', () =>
    invokeStashApply(dir, oid, false, pop),
  )
  if (!result) {
    // `run()` 已经刷过一次状态；再读一次，按「有没有冲突」决定要不要补那句话
    await refreshStatus()
    const conflicts = (gitStore.snapshot?.entries ?? []).filter(
      (entry) => entry.kind === 'unmerged',
    ).length
    if (conflicts > 0) {
      runInAction(() => {
        if (!gitStore.errorBox) return
        gitStore.errorBox = {
          ...gitStore.errorBox,
          text: `${gitStore.errorBox.text}\n\n${t(
            '工作区已留下冲突标记：在编辑器里解决后暂存，或丢弃这些文件再重试。',
          )}`,
        }
      })
    }
    return false
  }
  runInAction(() => {
    gitStore.snapshot = result.snapshot
    gitStore.stashes = result.stashes
    // pop 把这条删了：它不再是「可撤销的删除」（再撤销等于凭空多出一条）
    if (pop && gitStore.lastDropped?.oid === oid) gitStore.lastDropped = null
  })
  // 应用后工作区多了一批改动：行数统计必须重取（否则行内不显示 +N −M，看着像「没改动」）
  void refreshStats()
  showToast(pop ? t('已应用并删除贮藏') : t('已应用贮藏（条目保留）'))
  return true
}

/** 删除贮藏（⚠️ 破坏性：二次确认；删掉的条目在本会话内可撤销） */
export async function dropStash(oid: string): Promise<boolean> {
  const dir = gitStore.dir
  if (!dir || !gitStore.repo) return false
  const entry = gitStore.stashes.find((item) => item.oid === oid)
  const summary = entry
    ? stashSummary(entry, t('（无贮藏信息）'))
    : oid.slice(0, 7)
  const ok = await MessagePrompt.propt(
    t('删除这条贮藏？'),
    `${summary}\n\n${t('删除后可以在本次会话里撤销；关闭应用之后只能靠 git reflog 找回。')}`,
    { confirmText: t('删除'), cancelText: t('取消'), danger: true },
  )
  if (!ok) return false
  const result = await run('stash_drop', () => invokeStashDrop(dir, oid))
  if (!result) return false
  runInAction(() => {
    gitStore.stashes = result.stashes
    gitStore.lastDropped = { oid: result.oid, message: result.message }
  })
  showToast(t('已删除贮藏'))
  return true
}

/** 撤销删除：`stash store` 把同一个 oid 放回列表顶部 */
export async function undoDropStash(): Promise<void> {
  const dir = gitStore.dir
  const dropped = gitStore.lastDropped
  if (!dir || !gitStore.repo || !dropped) return
  const list = await run('stash_restore', () =>
    invokeStashRestore(dir, dropped.oid, dropped.message),
  )
  if (!list) return
  runInAction(() => {
    gitStore.stashes = list
    gitStore.lastDropped = null
  })
  showToast(t('已恢复删除的贮藏'))
}
