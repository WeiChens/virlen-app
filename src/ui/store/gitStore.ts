/**
 * gitStore — 「源代码管理」面板的**唯一状态源**（mobx observable）。
 *
 * 只放界面要渲染的东西：仓库信息、快照、分支、进行中的操作、错误。
 * ⚠️ **不缓存 diff 正文**（差异视图自己按需取、用完即弃）：把文件正文留在 store 里，
 * 只会让「面板关掉之后还抱着一堆文本」和「切了分支却还在显示旧内容」这两个问题同时出现。
 *
 * 方案：`docs/git-management-plan.md`。
 */
import { makeObservable, observable } from 'mobx'
import type {
  GitBranchInfo,
  GitRemoteInfo,
  GitRepoInfo,
  GitStashEntry,
  GitStatReport,
  GitStatusSnapshot,
} from '@/domain/git'

class GitStore {
  /**
   * 面板绑定的**工作目录**（= 当前会话工作目录）；`null` = 还没定。
   *
   * ⚠️ 它可以是仓库的**任意子目录**：路径基准（cwd = 仓库根、路径 = 仓库根相对）由 Rust 侧
   * `repo::root_of` 统一，前端不做任何路径拼接（见 `docs/agents/14-git-management.md` §11.53 ⑫）。
   */
  dir: string | null = null
  /** 是否已对当前 dir 探测过 —— 区分「还没探」与「探过、不是 Git 仓库」 */
  probed = false
  repo: GitRepoInfo | null = null
  /** 不可用原因（未检测到 git / 探测出错）—— `null` = 一切正常 */
  unavailable: string | null = null
  snapshot: GitStatusSnapshot | null = null
  /**
   * 逐文件行数统计（`+12 −3` 与顶部合计）—— **只在面板打开时取**：它比 `status` 贵（多了两次
   * `git diff` + 一次 `ls-files`），面板关着时只有徒标数文件，不需要行数。
   */
  stats: GitStatReport | null = null
  branches: GitBranchInfo[] = []
  /** 远程仓库（`git remote -v`）—— 同步浮层据此显示地址 / 类型，也据此判断「有没有配远程」 */
  remotes: GitRemoteInfo[] = []
  /**
   * 贮藏条目（新 → 旧）。
   *
   * **不随面板刷新轮询**：只在贮藏浮层打开 / 贮藏写操作后取（列表比 `status` 贵，而面板关着时
   * 没有任何地方要展示它）。
   */
  stashes: GitStashEntry[] = []
  /**
   * 最近一次**删除**的贮藏（供「撤销删除」）：`stash store` 能把同一个 oid 放回栈顶。
   * 只留最近一条 —— 撤销是「刚删错了」的兜底，不是历史记录。
   */
  lastDropped: { oid: string; message: string } | null = null
  /** 首次加载（骨架屏） */
  loading = false
  /** 正在进行的操作名（按钮禁用 + 文案）；`null` = 空闲 */
  busy: string | null = null
  /** 最近一次错误（面板顶部一句话；任何一次成功都会清空它） */
  error: string | null = null
  /**
   * 失败弹窗的内容（`run()` 失败时填）—— **持久**，只能由用户关掉。
   *
   * 为什么不用 toast：git 的报错是多行 stderr，真正的下一步常写在 `hint:` 行上；
   * 几秒就消失的提示既读不完、也不能复制，用户还没看清就没了。
   */
  errorBox: { op: string; text: string } | null = null
  /** 面板是否打开 —— 刷新时机由它决定（关闭时不做任何 IO） */
  open = false
  /** 提交信息草稿（面板重开后仍在：写一半切走不该丢） */
  commitDraft = ''
  /**
   * 最近一次提交里 git 的 stderr（hooks 的输出 / 警告）—— 非空才展示「提交输出」块。
   *
   * 正常提交为空，所以它不是「提交日志」，而是「这次提交有没有顺手动过什么」的告警。
   * 只留最近一份：下一条提交覆盖它，用户手动关掉也清空。
   */
  hookOutput: string | null = null

  /**
   * 最近一次**网络操作**（fetch / pull / push）的 git 输出 —— 非空才展示。
   *
   * 与 `hookOutput` 分开：两者来源不同、时机不同（提交不一定推送），共用一份字段会出现
   * 「推了一下，提交输出块现在装的是 push 的进度」这种错位。
   */
  syncOutput: string | null = null

  constructor() {
    makeObservable(this, {
      dir: observable,
      probed: observable,
      repo: observable,
      unavailable: observable,
      snapshot: observable,
      stats: observable,
      branches: observable,
      remotes: observable,
      stashes: observable,
      lastDropped: observable,
      loading: observable,
      busy: observable,
      error: observable,
      errorBox: observable,
      open: observable,
      commitDraft: observable,
      hookOutput: observable,
      syncOutput: observable,
    })
  }
}

/** 全局单例 —— 组件直接 import 使用 */
export const gitStore = new GitStore()
