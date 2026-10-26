/**
 * 右侧面板的标签页模型（纯函数：容器与宿主共用这一份，不碰 DOM、不碰 React）。
 *
 * 三条口径：
 * 1. **id 由内容决定**：文件是 `file:<绝对路径>`，服务终端是 `service:<会话id>:<服务id>`
 *    （服务 id 只在会话内唯一）。同一个内容再点一次是「激活已有标签」而不是再开一个 ——
 *    文件开两份会各持一份草稿、互相踩；终端开两份则是两个 xterm 抢同一个伪控制台；
 *    ⚠️ 但这只对**同一个会话**成立：宿主把标签按会话分桶（`side-panel/sessions.ts`），
 *    落库时给 id 加一个会话前缀 —— 同一个文件在两个会话里各有一份草稿，id 必须分开。
 *    所以**去重一律按内容（kind + 路径 / 服务 / 终端 id）判，不按 `id` 字符串比**：
 *    `id` 在容器眼里是不透明的渲染 key（前缀由宿主加），比对它就会「同一个文件开两份」；
 * 2. **kind 目前六种**：`file`（文本编辑 / 预览）、`service`（后台服务终端）、
 *    `guide`（开始页：右侧栏的「门厅」，三个入口胶囊）、`files`（工作区文件树）、
 *    `terminal`（**用户自己的交互终端**，一个终端一个标签）与 `browser`（**网页**，
 *    一个网页一个标签）。渲染分支在 `index.tsx::renderTab()`，加一种内容只加一支；
 *    打开/关闭/选中这套逻辑不用改；
 * 3. **关掉当前激活的标签**：请**右边**那位上来（浏览器的口径：关掉当前页，右边那页顶上来），
 *    没有右邻居再退到左边；全关光就是 `null`（宿主据此把整个容器卸掉）。
 * 4. **批量关闭（标签右键菜单）**：按「逐个 `closeTab`」的口径收敛激活态 —— 语义只有一份，
 *    免得「关闭其他」自己再写一套邻居规则。
 * 5. **重排（拖标签）**：`moveTab` 的下标是「插入到最终位置」，与拖动时的落点算法同口径
 *    （见 `index.tsx::startTabDrag`：数「其他标签中线在指针左边」的个数），两边不能各算一套。
 * 6. **文件标签有两种持留方式：预览位 / 常驻**（`pinned`）。
 *    - **预览位**（`pinned !== true`，用户点开 / 拖进来的都是它）：标签文字是斜体，
 *      **下一个打开的文件顶掉它**（`openFileTab` 的 `activeId` 就是那一格）—— 逛文件树时
 *      不会攒出十几个「路过看一眼」的标签；
 *    - **常驻**（present 的交付物、用户明确要留下看的）：谁都不顶它，追加到末尾。
 *    - 升级只有四条路（都在本文件里判，容器 / 宿主只负责传话）：
 *      ① present 交付（`pinned: true`）；② 再次打开**已经激活的**它（`current.id === activeId`）；
 *      ③ 双击标签（`pinTab`）；④ 改动草稿 → 脏（容器上报脏时顺手 `pinTab`）。
 *      常驻之后**永不退回**预览位：那是用户的判断，不该被下一次点击改掉。
 */

/** 右侧面板的一个标签页（扩 kind 时在这里加联合项） */
export type SidePanelTab =
  | {
      id: string
      kind: 'file'
      /** 文件绝对路径（工作目录内） */
      path: string
      /** 打开时落在哪个视图（缺省 = 编辑；present 的交付物是预览） */
      view?: FileTabView
      /** 「又请你看一次」的序号：present 每次都自增，面板据此把视图迁回去 */
      viewSeq?: number
      /**
       * 常驻模式（`true`）/ 预览位（`false` 或缺省）—— 见头注释第 6 条。
       * 预览位：标签文字斜体，下一个打开的文件会**顶掉它**；改草稿 / 双击标签 / present
       * 都会把它变成常驻，此后不再被顶掉。
       */
      pinned?: boolean
    }
  | {
      id: string
      kind: 'service'
      /** 归属会话（同一服务 id 只在**它自己的**会话里唯一） */
      sessionId: string
      serviceId: string
      /** 标签上显示的服务名：列表还没轮询回来时也要有标题 */
      name: string
      /** 归属会话标签（新对话页的全局视图才有；本会话视图不显示） */
      sessionLabel?: string
    }
  | {
      id: string
      kind: 'guide'
    }
  | {
      id: string
      kind: 'files'
    }
  | {
      id: string
      kind: 'terminal'
      /** 终端 id（Rust 侧 `term_N`，**全局唯一** —— 计数在 Rust 里） */
      termId: string
      /** 归属会话（关标签时要拿它去 `cmd_terminal_kill`；会话隔离靠它） */
      sessionId: string
      /** 实际使用的 shell 类型 id（`powershell` / `cmd` / `pwsh` / `gitbash`）—— **标签标题就是它**
       *（`terminal/shells.tsx::shellLabel`），同名无所谓，不编序号 */
      shell: string
      /** 工作目录（会话工作区）—— 只给标签 tooltip 用（面板里不再占一行元信息） */
      cwd: string
      /** shell 进程 pid（开终端时 Rust 回的；**只用于诊断**，界面不展示） */
      pid: number
    }
  | {
      id: string
      kind: 'browser'
      /**
       * 当前地址（空串 = 空白页，等着用户输入）。
       * 它是**面板的镜像**：面板里每次导航都会回调宿主写回这里，标签标题因此跟着换；
       * 反方向不成立 —— 面板只在挂载时读一次，之后地址归它自己管（历史在它那儿）。
       */
      url: string
      /**
       * 页面自己报上来的 `document.title`（标签栏优先显示它）。
       * 空串 / 未设置 = 还没拿到：退回主机名（`urlLabel`），而不是给一个空标签。
       * ⚠️ 不落盘：标题是运行时状态，重启后应当重新由页面报上来。
       */
      title?: string
      /** 宿主自增的序号：只用来造 id（`browser:3`），不显示（标题优先用页面标题） */
      seq: number
    }

/** 右侧栏的「页面」（按 kind 打开，不像文件 / 服务那样按内容身份去重） */
export type SidePanelPageKind = 'guide' | 'files'

/** 开始页的标签 id（同会话只一个：再点「+」只切过去） */
export const GUIDE_TAB_ID = 'guide'

/** 工作区文件树的标签 id（树根跟着当前会话走，所以不把路径编进 id） */
export const FILES_TAB_ID = 'files'

/** 文件标签打开时落在哪个视图：present 的交付物默认给人看，普通打开仍是给人改 */
export type FileTabView = 'edit' | 'preview'

export function fileTabId(path: string): string {
  return `file:${path}`
}

/** 造一个文件标签（`pinned` 缺省 = 预览位：用户打开的都是「先看一眼」） */
export function fileTab(
  path: string,
  view?: FileTabView,
  viewSeq?: number,
  pinned?: boolean,
): SidePanelTab {
  return { id: fileTabId(path), kind: 'file', path, view, viewSeq, pinned: pinned === true }
}

/**
 * 这个标签是「预览位」吗（斜体 + 会被下一个打开的文件顶掉）。
 * 只有文件标签有这个概念：服务 / 终端 / 网页 / 页面都是用户明确要的东西。
 *
 * ⚠️ 故意不写成类型谓词（`tab is 文件标签`）：那样调用处写在 `tab.kind === 'file'` 里面时，
 * 否定分支会被 TS 算成 `never`（谓词的否分支是「排除整个文件标签」），
 * 于是 `isPreviewTab(tab) ? … : tab.path` 这种写法反而编译不过。
 */
export function isPreviewTab(tab: SidePanelTab): boolean {
  return tab.kind === 'file' && tab.pinned !== true
}

/** 服务终端标签的 id：会话 + 服务（服务 id 只在会话内唯一，跨会话会撞） */
export function serviceTabId(sessionId: string, serviceId: string): string {
  return `service:${sessionId}:${serviceId}`
}

/** 用户终端标签的 id：终端 id 本身全局唯一（Rust 侧计数器）——前缀仍由宿主按会话加 */
export function terminalTabId(termId: string): string {
  return `terminal:${termId}`
}

/** 网页标签的 id：`seq` 是宿主自增的序号（同一个网址可以开两个标签，浏览器口径） */
export function browserTabId(seq: number): string {
  return `browser:${seq}`
}

/** 造一个网页标签（`url` 空串 = 空白页） */
export function browserTab(input: { seq: number; url?: string }): SidePanelTab {
  return { id: browserTabId(input.seq), kind: 'browser', url: input.url ?? '', seq: input.seq }
}

/**
 * 打开一个网页标签。
 *
 * 与文件 / 终端**不同**：这里不去重 —— 同一个网址开两个标签是浏览器最基本的用法
 *（对照两个分支、同一个文档的不同锚点）；身份是 `seq`，所以两份互不影响。
 */
export function openBrowserTab(
  tabs: SidePanelTab[],
  input: { seq: number; url?: string },
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const tab = browserTab(input)
  return { tabs: [...tabs, tab], activeId: tab.id, added: true }
}

/**
 * 面板里导航了一次 → 把地址写回标签（标签标题 = 主机名，所以标题会跟着换）。
 * 地址没变 / 标签已经关掉 / 不是网页标签时返回原引用（宿主据此跳过重渲染）。
 */
export function updateBrowserTab(
  tabs: SidePanelTab[],
  id: string,
  url: string,
): SidePanelTab[] {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return tabs
  const tab = tabs[index]
  if (tab.kind !== 'browser' || tab.url === url) return tabs
  const next = [...tabs]
  next[index] = { ...tab, url }
  return next
}

/**
 * 页面报来新标题 → 写到标签上（标签栏显示它）。
 *
 * 标题没变 / 标签已经关掉 / 不是网页标签时返回原引用（宿主据此跳过重渲染）。
 * ⚠️ 标题与地址是两件事：SPA 换标题时 `url` 可能没变，反过来也一样。
 */
export function updateBrowserTitle(
  tabs: SidePanelTab[],
  id: string,
  title: string,
): SidePanelTab[] {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return tabs
  const tab = tabs[index]
  const nextTitle = title.trim()
  // 空白标题当「没拿到」：留着上一次的，也不给标签一个空文字
  if (tab.kind !== 'browser' || !nextTitle || tab.title === nextTitle) return tabs
  const next = [...tabs]
  next[index] = { ...tab, title: nextTitle }
  return next
}

/** 造一个用户终端标签 */
export function terminalTab(input: {
  termId: string
  sessionId: string
  shell: string
  cwd: string
  pid: number
}): SidePanelTab {
  return { id: terminalTabId(input.termId), kind: 'terminal', ...input }
}

/** 造一个服务终端标签 */
export function serviceTab(input: {
  sessionId: string
  serviceId: string
  name: string
  sessionLabel?: string
}): SidePanelTab {
  return {
    id: serviceTabId(input.sessionId, input.serviceId),
    kind: 'service',
    ...input,
  }
}

/** 造一个「页面」标签（开始页 / 工作区文件树） */
export function pageTab(kind: SidePanelPageKind): SidePanelTab {
  return { id: kind === 'guide' ? GUIDE_TAB_ID : FILES_TAB_ID, kind }
}

/**
 * 打开一个「页面」：已开着就只切过去，否则追加到末尾。
 *
 * 与 `openFileTab` 同一形状（`{ tabs, activeId, added }`）—— 宿主只记一套口径。
 */
export function openPageTab(
  tabs: SidePanelTab[],
  kind: SidePanelPageKind,
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const tab = pageTab(kind)
  // 按 kind 找（不按 id）：id 上可能带着宿主的会话前缀
  const opened = tabs.find((item) => item.kind === kind)
  if (opened) return { tabs, activeId: opened.id, added: false }
  return { tabs: [...tabs, tab], activeId: tab.id, added: true }
}

/**
 * 在「开始页」里点了一个入口：把开始页**原地换成**目标页（参考实现的口径 ——
 * 开始页是门厅，不是常驻页面；点完就该消失，标签栏不留一个「开始」）。
 *
 * 三种情形：
 * - 目标页没开着 → 新标签落在开始页原来的位置上（用户看到的还是那一格）；
 * - 目标页已经开着 → 只把它激活，顺手把开始页关掉；
 * - 传进来的 `fromId` 已经不在（菜单开着时被关掉）→ 退化成普通的 `openPageTab`。
 */
export function replacePageTab(
  tabs: SidePanelTab[],
  kind: SidePanelPageKind,
  fromId: string,
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const opened = openPageTab(tabs, kind)
  if (!tabs.some((item) => item.id === fromId)) return opened
  // 目标页已经开着：只需激活它，再把来源页（开始页）关掉
  if (!opened.added) {
    return {
      tabs: opened.tabs.filter((item) => item.id !== fromId),
      activeId: opened.activeId,
      added: false,
    }
  }
  // 新标签先挿在末尾：要接管来源页那一格，先把「来源页 + 它自己」一起摸出来
  const rest = opened.tabs.filter(
    (item) => item.id !== fromId && item.id !== opened.activeId,
  )
  const from = tabs.findIndex((item) => item.id === fromId)
  const moved = opened.tabs.find((item) => item.id === opened.activeId)!
  const at = Math.max(0, Math.min(from, rest.length))
  const next = [...rest]
  next.splice(at, 0, moved)
  return { tabs: next, activeId: opened.activeId, added: true }
}

/** 打开一个服务终端标签：已开着就只切过去（同一个伪控制台不能交给两份 xterm） */
export function openServiceTab(
  tabs: SidePanelTab[],
  input: { sessionId: string; serviceId: string; name: string; sessionLabel?: string },
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  // 按「会话 + 服务」找（不按 id）：服务 id 只在会话内唯一，与标签 id 的前缀无关
  const opened = tabs.find(
    (tab) =>
      tab.kind === 'service' &&
      tab.sessionId === input.sessionId &&
      tab.serviceId === input.serviceId,
  )
  if (opened) return { tabs, activeId: opened.id, added: false }
  const tab = serviceTab(input)
  return { tabs: [...tabs, tab], activeId: tab.id, added: true }
}

/**
 * 把一个**新**标签放在 `fromId` 原来那一格（并关掉 `fromId`）。
 *
 * 开始页的「新建终端」用它：起终端是异步的（先 `cmd_terminal_start`，拿到 id 才有标签），
 * 所以不能走 `replacePageTab`（那个只认页面 kind）。用户看到的仍然是「点了那一扇门，
 * 它就变成了终端」—— 标签不多出一个，位置也不跳。
 * `fromId` 已经不在了（菜单开着时被关掉）→ 追加到末尾。
 */
export function replaceTabWith(
  tabs: SidePanelTab[],
  tab: SidePanelTab,
  fromId: string,
): { tabs: SidePanelTab[]; activeId: string } {
  const rest = tabs.filter((item) => item.id !== fromId && item.id !== tab.id)
  const from = tabs.findIndex((item) => item.id === fromId)
  const at = from < 0 ? rest.length : Math.min(from, rest.length)
  const next = [...rest]
  next.splice(at, 0, tab)
  return { tabs: next, activeId: tab.id }
}

/** 打开一个终端标签：同一个终端不会开出两份（两个 xterm 抢一个伪控制台） */
export function openTerminalTab(
  tabs: SidePanelTab[],
  input: {
    termId: string
    sessionId: string
    shell: string
    cwd: string
    pid: number
  },
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const tab = terminalTab(input)
  // 按终端 id 找（不按标签 id）：两个 xterm 抢一个伪控制台是必须防的事
  const opened = tabs.find((item) => item.kind === 'terminal' && item.termId === input.termId)
  if (opened) return { tabs, activeId: opened.id, added: false }
  return { tabs: [...tabs, tab], activeId: tab.id, added: true }
}

/** 打开一个文件的选项（视图提示 + 常驻模式 + 当前激活的是谁） */
export interface OpenFileOptions {
  /** 打开时落在哪个视图（present 的交付物是 `preview`） */
  view?: FileTabView
  /** 「又请你看一次」的序号（present 每次自增） */
  viewSeq?: number
  /** 常驻模式（present 的交付物）；不传 = 预览位，会被下一个打开的文件顶掉 */
  pinned?: boolean
  /**
   * 当前激活的标签 id。两个用途：**预览位替换**（激活的那个是预览位文件标签 → 新文件占它那一格）
   * 与「**再打开已经激活的它** → 升级成常驻」。拿不准就传宿主的 `bucket.activeId`。
   */
  activeId?: string | null
}

/**
 * 预览位在哪：**当前激活的那个预览位文件标签**的下标；`-1` = 没有可占的格子（新标签追加到末尾）。
 *
 * 只认文件标签、只认预览位 —— 常驻标签（present 交付 / 用户动手留下看的）不许被顶掉，
 * 服务 / 终端 / 网页 / 页面也一样（它们背后有进程、有历史，不是「路过看一眼」）。
 */
function previewSlotIndex(tabs: SidePanelTab[], activeId: string | null): number {
  if (!activeId) return -1
  const index = tabs.findIndex((tab) => tab.id === activeId)
  if (index < 0) return -1
  return isPreviewTab(tabs[index]) ? index : -1
}

/**
 * 打开一个文件（右侧栏唯一的入口）。三条口径：
 *
 * 1. **已有同路径的标签**就只切过去，草稿一个字都不动；`.view` / `.viewSeq` 有变才换标签
 *    （present 再看一次同一个文件要把面板请回预览；普通打开不碰用户手动切走的视图）。
 *    顺手按头注释第 6 条判升级：`pinned: true`（present 交付）或「打开的就是激活着的它」。
 * 2. **没有就新开**：预览位（`pinned !== true`）且激活的那个也是预览位 → **顶掉它那一格**
 *    （下标不变，标签数量不变 —— 逛文件树不会攒出十几个标签）；否则追加到末尾。
 * 3. 视图中「谁被激活」由调用方传 `activeId` 决定 —— 本函数不猜，纯函数口径不变。
 *
 * ⚠️ 顶掉预览位 = 那一格的面板**卸载**（草稿、撤销栈一起没）。所以「改动过」必须先把标签
 * 升级成常驻（容器在脏上报时做，见 `side-panel/index.tsx`）—— 能顶掉的永远只有干净的预览位。
 * 也因此这里**不需要任何「丢弃草稿」的确认**（旧实现是单面板，换文件必须问）。
 */
export function openFileTab(
  tabs: SidePanelTab[],
  path: string,
  options: OpenFileOptions = {},
): { tabs: SidePanelTab[]; activeId: string; added: boolean } {
  const { view, viewSeq } = options
  const activeId = options.activeId ?? null
  // 按路径找（不按 id）：id 上带着宿主的会话前缀，拿它比会「同一个文件开两份」
  const index = tabs.findIndex((item) => item.kind === 'file' && item.path === path)

  if (index < 0) {
    const tab = fileTab(path, view, viewSeq, options.pinned === true)
    // 常驻（present）从不顶别人的格子：交付物是「请看这个」，不是「换掉你手上的那个」
    const slot = options.pinned === true ? -1 : previewSlotIndex(tabs, activeId)
    if (slot < 0) return { tabs: [...tabs, tab], activeId: tab.id, added: true }
    const next = [...tabs]
    next[slot] = tab
    return { tabs: next, activeId: tab.id, added: true }
  }

  const current = tabs[index]
  if (current.kind !== 'file') {
    return { tabs, activeId: current.id, added: false }
  }
  // 升级成常驻：present 交付，或「再打开一次已经激活着的它」（用户点第二遍 = 我要留着）
  const pinned = current.pinned === true || options.pinned === true || current.id === activeId
  const nextView = view ?? current.view
  const nextSeq = viewSeq ?? current.viewSeq
  if (
    nextView === current.view &&
    nextSeq === current.viewSeq &&
    pinned === (current.pinned === true)
  ) {
    return { tabs, activeId: current.id, added: false }
  }
  const next = [...tabs]
  next[index] = { ...current, view: nextView, viewSeq: nextSeq, pinned }
  return { tabs: next, activeId: current.id, added: false }
}

/**
 * 把一个**预览位**标签升级成常驻（双击标签 / 改动草稿两条路）。
 *
 * 不是文件标签 / 已经常驻 / 标签已经关掉 → 返回原引用（宿主据此跳过重渲染）。
 * 反向不提供：常驻 → 预览位没有任何入口（用户留下的东西不该被下一次点击改掉）。
 */
export function pinTab(tabs: SidePanelTab[], id: string): SidePanelTab[] {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return tabs
  const tab = tabs[index]
  if (tab.kind !== 'file' || tab.pinned === true) return tabs
  const next = [...tabs]
  next[index] = { ...tab, pinned: true }
  return next
}

/**
 * 关掉一个标签。关的不是当前激活的那个 → 激活态不动；关的是激活的 →
 * 右邻居上来，没有右邻居取左邻居，都没有则 `null`。
 */
export function closeTab(
  tabs: SidePanelTab[],
  id: string,
  activeId: string | null,
): { tabs: SidePanelTab[]; activeId: string | null } {
  const index = tabs.findIndex((item) => item.id === id)
  // 已经关过了（双击 / 竞态）：原样返回，别把激活态弄丢
  if (index < 0) return { tabs, activeId }

  const rest = tabs.filter((item) => item.id !== id)
  if (id !== activeId) return { tabs: rest, activeId }
  const next = rest[index] ?? rest[index - 1] ?? null
  return { tabs: rest, activeId: next?.id ?? null }
}

/**
 * 关掉**一批**标签（右键菜单的关闭其他 / 关闭右侧标签页 / 关闭已保存 / 全部关闭）。
 *
 * 收敛口径就是逐个走 `closeTab`：被关的里面有激活标签时，右邻居一路顶上来，
 * 于是「关闭其他」自然停在唯一剩下的那个标签上（不需要额外的「激活谁」参数）。
 * 只多一条兜底：关到「剩一个但激活态是 null」时退回第一个 —— 宿主 `activeId=null`
 * 虽然会被容器兜底显示，但下次关标签的邻居计算会失去基准。
 */
export function closeTabs(
  tabs: SidePanelTab[],
  ids: readonly string[],
  activeId: string | null,
): { tabs: SidePanelTab[]; activeId: string | null } {
  const doomed = new Set(ids)
  let state = { tabs, activeId }
  // 按 tabs 顺序关（不是按 ids 顺序）：邻居规则依赖原顺序，乱序关会让激活态跳得没有道理
  for (const tab of tabs) {
    if (doomed.has(tab.id)) state = closeTab(state.tabs, tab.id, state.activeId)
  }
  if (state.tabs === tabs) return state
  return {
    tabs: state.tabs,
    activeId: state.activeId ?? state.tabs[0]?.id ?? null,
  }
}

/**
 * 把 `id` 挪到第 `toIndex` 位（数组下标，按「先取出再插入」算：右移时落点即最终下标）。
 * 越界夹进范围、位置没变就返回原引用（宿主据此不做无意义的重渲染）。
 */
export function moveTab(
  tabs: SidePanelTab[],
  id: string,
  toIndex: number,
): SidePanelTab[] {
  const from = tabs.findIndex((item) => item.id === id)
  if (from < 0) return tabs
  const to = Math.max(0, Math.min(tabs.length - 1, toIndex))
  if (to === from) return tabs
  const next = [...tabs]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** 标签上显示的名字：文件名（路径可能是 Windows 反斜杠） */
export function tabLabel(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

/** 文件名之外的目录部分（空串 = 就在根上）；标签栏和面板头都用它做次要信息 */
export function tabDir(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/')
}
