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
import type { GitBranchInfo, GitRepoInfo, GitStatusSnapshot } from '@/domain/git'

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
  /** 不可用原因（不是仓库 / 未检测到 git）—— `null` = 一切正常 */
  unavailable: string | null = null
  snapshot: GitStatusSnapshot | null = null
  branches: GitBranchInfo[] = []
  /** 首次加载（骨架屏） */
  loading = false
  /** 正在进行的操作名（按钮禁用 + 文案）；`null` = 空闲 */
  busy: string | null = null
  /** 最近一次错误（面板顶部展示；任何一次成功都会清空它） */
  error: string | null = null
  /** 面板是否打开 —— 刷新时机由它决定（关闭时不做任何 IO） */
  open = false
  /** 提交信息草稿（面板重开后仍在：写一半切走不该丢） */
  commitDraft = ''

  constructor() {
    makeObservable(this, {
      dir: observable,
      probed: observable,
      repo: observable,
      unavailable: observable,
      snapshot: observable,
      branches: observable,
      loading: observable,
      busy: observable,
      error: observable,
      open: observable,
      commitDraft: observable,
    })
  }
}

/** 全局单例 —— 组件直接 import 使用 */
export const gitStore = new GitStore()
