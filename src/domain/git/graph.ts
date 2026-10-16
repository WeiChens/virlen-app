/**
 * graph — 提交图的**布局 / 配色 / 绘制指令**（纯函数，唯一实现）。
 *
 * 「一个提交一个点、一个分支一条线」在 DAG 上要落到两件事上：**点之间的父子边**（线）与
 * **lane（列）**（同一时刻并排的一条历史线 —— 一条 lane 不等于一个分支，分支合回去之后这条 lane
 * 会被别的分支复用）。所以：
 *
 * - 布局：把「已经按 `--date-order` 排好、父必排在子之后」的提交列表逐行推进成列（见 `layoutGraph`）；
 * - 配色：**同一连通分量内不重复、分量之间可复用**（= 用户口径「有交集必不同色、毫无交集可同色」）；
 * - 绘制：本模块只产出**坐标 + 尺寸**（`PaintOp[]`），往 canvas 上涂是 `GraphCanvas` 的事 ——
 *   ⚠️ jsdom 里没有 2D 上下文，**能断言的只有这里**，所以「画什么」必须全部留在纯函数里；
 * - 宽度：**行内让位按「本行画到的最大列」给**（`rowExtent`），不是整窗口最宽那一行（见第 4 条）。
 *
 * ⚠️ 四条口径错了都是静默的（图看着「有点怪」但不报错）：
 * 1. **行高必须是固定像素**（`GRAPH_ROW_H`）：坐标是按行高算的绝对值，跟界面字号缩放就会逐行错位；
 * 2. **连通分量只按「已加载窗口内可见的边」算**：两个分支若只在更早的历史里交汇（窗口外），
 *    图上就是看不出交集 → 允许同色。代价是「加载更多」后可能重着色（纯函数是确定的，只是窗口变了）；
 * 3. **同一列可以在同一行被多个子提交期待**（一个提交有多个子时）：必须合并成一条线，
 *    否则同一列会画出两条重复的线、列也不会被释放；
 * 4. **让位宽度逐行算，但列宽必须用整窗口那一份**：早先每行按「整窗口最宽那一行」（`laneCount`）
 *    留位 —— 实测（30 个分支逐个 Merge 的仓库）31 列 = 229px 空白，而那一屏可见的行只用到前 1–3 列，
 *    这就是「图与文字之间一大片留白」的根。改成逐行按 `rowExtent` 之后还有第二半：**列宽也得取整份
 *    布局的列宽**（`graphGeometry`），不能按「本行占几列」反算 —— 密集窗口里 `laneWidth(11)` = 14px
 *    而窗口实际 7px，每行白空 60–85px（实测 21 列：占 11 列的行留 166px，实际只需 81.6px）。
 *    ⚠️ canvas **在行之上**（绝对定位 + `z-index`，见 `style.scss`），所以让位宽度不够的后果是
 *    **线压在字上**，不是「字被线遮住」。
 */

/** 一行提交在图里需要的东西（`GitCommitLogEntry` 的最小子集 —— 纯函数不该依赖整条记录） */
export interface GraphCommit {
  oid: string
  parents: string[]
}

/**
 * 一段线（**行内坐标**：x = 列号，y 用行内比例 —— 0 = 本行顶边、0.5 = 本行节点中线、1 = 底边）。
 *
 * 用比例而不是像素：布局不关心行高，`paintOps` 乘一次就行（换行高不用重算布局）。
 */
export interface GraphSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  color: number
  /** 分叉 / 合并的斜线用平滑曲线画；贯穿的竖线为 `false`（画直线） */
  curve: boolean
}

export interface GraphRow {
  oid: string
  /** 本提交所在的列 */
  lane: number
  color: number
  /** 本行要画的线（不含节点本身） */
  segments: GraphSegment[]
}

export interface GraphLayout {
  rows: GraphRow[]
  /** 窗口内出现过的最大列数（决定画布宽度，见 `graphWidth`） */
  laneCount: number
}

/** 调色板大小（暗 / 亮各一套，颜色本身在 `theme.scss` 的 `--git-graph-1..8` 里） */
export const PALETTE_SIZE = 8

/**
 * 调色板在「读不到 CSS 变量」时的兵底（不是浏览器 / 测试环境：`getComputedStyle` 拿不到自定义属性）。
 * ⚠️ 它必须与 `theme.scss` 的**暗色**那块逐个相等 —— 否则就会退化成「亮色主题上画着暗色档的线」
 * （就是 §11.53 ⑭ 那个「fallback 永远生效」的坑）。两者的相等由 `tests/domain/git-graph.test.ts` 扫文本钉住。
 */
export const GRAPH_PALETTE_FALLBACK: readonly string[] = [
  '#6cb6ff',
  '#c9a0ff',
  '#ffb86b',
  '#7ee787',
  '#56d4dd',
  '#ff8fb1',
  '#e3d05a',
  '#9aa4b2',
]

/**
 * 行高（px）—— **与 SCSS 里的 `--git-graph-row-h` 必须是同一个数**。
 * ⚠️ 它是**硬编码像素**，不跟界面字号缩放：坐标是按它算的（同 P1.16 那条「车道宽度是硬编码像素」）。
 * 两者的相等由 `tests/domain/git-graph.test.ts` 扫 SCSS 文本钉住。
 *
 * 30 是「装得下最大档字号」的下界：行内 padding 5+5，字号最大档 13px × 行高 1.5 ≈ 19.5px ≤ 20px 内容高。
 */
export const GRAPH_ROW_H = 30

/** 列宽上限（px） */
export const LANE_W = 14
/**
 * 图列总宽的**软上限**（px）：列一多就把列宽压窄（列不互相挤），压到 `MIN_LANE_W` 为止。
 *
 * ⚠️ 下限不能取「6px 那种较大的数」：`max(6, MAX/n) * n` 在 40 列以后就退回 6px × 列数、线性暴涨
 * （实测 63 列 = 390px 空白 —— 那正是用户看到的那堵「空白墙」，见模块头第 4 条）。
 * 软上限的含义：40 列以内总宽都 ≤ `MAX_GRAPH_W` + 两侧内边距；再多的列只能每列 `MIN_LANE_W` 地长。
 */
export const MAX_GRAPH_W = 160
/** 列宽下限（px）：再窄线与节点就糊在一起（4px 列宽下 `nodeRadius(4)` = 1.2px 仍分得出「一条线一个点」） */
export const MIN_LANE_W = 4
/** 画布左右内边距（第一个点不要贴着边框） */
export const GRAPH_PAD_X = 6
/** 节点**半径上限**（px）—— 列宽够时用它，列密时按 `nodeRadius` 缩 */
export const NODE_R = 4

/**
 * 列宽：列少时用满 `LANE_W`，列多时压窄以守住 `MAX_GRAPH_W`（**不裁掉任何一列**），最窄 `MIN_LANE_W`。
 */
export function laneWidth(laneCount: number): number {
  const n = Math.max(1, laneCount)
  return Math.max(MIN_LANE_W, Math.min(LANE_W, Math.floor(MAX_GRAPH_W / n)))
}

/**
 * **画布**宽度（列宽 × 列数 + 两侧内边距）。
 * ⚠️ 别拿它算行内让位宽度（`graphWidth(rowExtent(row))` 正是上一版的坑：它按本行的列数反算列宽，
 *    密集窗口里每行白空 60–85px）—— 行内空位一律取 `graphGeometry().rowGutters`。
 */
export function graphWidth(laneCount: number): number {
  return laneWidth(laneCount) * Math.max(1, laneCount) + GRAPH_PAD_X * 2
}

/**
 * 节点半径：列宽够时是 `NODE_R`，列被压窄时按比例缩。
 * ⚠️ **直径必须 ≤ 列宽** —— 否则相邻两列的点重叠成一团（6px 列宽配 r=4 就是直径 8px，两边都压）。
 */
export function nodeRadius(laneWidth: number): number {
  return Math.max(1.2, Math.min(NODE_R, laneWidth * 0.3))
}

/** 线宽：14px 列宽时 2px，列压窄时跟着变细（上限是列宽的一半：并排两条线不会挨在一起） */
export function strokeWidth(laneWidth: number): number {
  return Math.max(1, Math.min(2, laneWidth / 7))
}

/**
 * 一行的**让位宽度**（占几列）：本行节点所在列与它所有线段的列取最大，再 +1。
 *
 * 行里的空位按它算，而不是按 `laneCount`（后者是「整个已加载窗口最宽的那一行」，拿它当宽度会让
 * 只用一列的行也白白空出几百像素 —— 见模块头第 4 条）。
 * ⚠️ 线段里已经含「穿过本行的竖线」与「分叉 / 合并的斜线」，所以这个宽度**一定盖得住本行画出来的
 *    东西**；少算一列，线就压在字上（canvas 在行**之上**，见 `style.scss`）。
 */
export function rowExtent(row: GraphRow): number {
  let right = row.lane
  for (const s of row.segments) right = Math.max(right, s.x1, s.x2)
  return right + 1
}

/**
 * 一行需要的**像素**左空位。
 *
 * ⚠️ `laneW` 必须是**整份布局**的列宽（`graphGeometry` 那份）—— 按「本行占几列」反算列宽会得到更
 *    宽的列（密集窗口里 `laneWidth(11)` = 14px 而窗口实际 7px），每行白空 60–85px。
 */
export function rowGutter(row: GraphRow, laneW: number): number {
  return GRAPH_PAD_X * 2 + rowExtent(row) * laneW
}

/**
 * 整份布局的几何 —— 画布宽度 / 列宽 / 每行让位宽度**唯一出口**（三处必须同源）。
 *
 * ⚠️ 这是上一版那个坑的兜底：画线用整窗口列宽、留位按本行反算列宽 → 两套几何各自演化，稀疏时碰巧
 *    一致、密集时白空 60–85px（实测 21 列 / 列宽 7px：占 11 列的行留 166px，实际只需 81.6px）；
 *    密度策略（`LANE_W` / `MAX_GRAPH_W` / `MIN_LANE_W`）一改，两套还会朝相反方向漂 —— 继续白空，
 *    或线压到字上。
 */
export function graphGeometry(layout: GraphLayout): {
  laneWidth: number
  canvasWidth: number
  rowGutters: number[]
} {
  const laneW = laneWidth(layout.laneCount)
  return {
    laneWidth: laneW,
    canvasWidth: graphWidth(layout.laneCount),
    rowGutters: layout.rows.map((row) => rowGutter(row, laneW)),
  }
}

// ==================== 布局 ====================

/**
 * 逐行推进的列分配（与 gitg / VS Code 的图同一套做法）。
 *
 * `commits` 必须**已经按「父不排在子之前」的顺序**给进来（Rust 侧用 `--date-order` 保证，
 * 见 `git/log.rs` 模块头第 6 条）—— 否则线要往下连而父已经画过了，图在结构上就不成立。
 */
export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const comp = visibleComponents(commits)
  /** 分量 → 已经用掉的色号（分量内不重复；分量之间从头复用） */
  const compUsed = new Map<string, Set<number>>()
  /** 每列「正在期待的 oid」（null = 空列，可复用）与其色号 */
  const lanes: (string | null)[] = []
  const colors: number[] = []
  const rows: GraphRow[] = []

  const compOf = (oid: string): string => comp.get(oid) ?? oid

  /** 给一列取色号：不碰「活跃列已用 + 本分量已用」的色；列数超过调色板只能按列号绕 */
  function assignColor(index: number, at: string): number {
    if (colors[index] >= 0) return colors[index]
    const taken = new Set<number>()
    for (let i = 0; i < lanes.length; i++) {
      if (i !== index && lanes[i] !== null && colors[i] >= 0) taken.add(colors[i])
    }
    const used = compUsed.get(compOf(at))
    if (used) for (const c of used) taken.add(c)
    let pick = 0
    while (pick < PALETTE_SIZE && taken.has(pick)) pick++
    if (pick >= PALETTE_SIZE) pick = index % PALETTE_SIZE
    if (used) used.add(pick)
    else compUsed.set(compOf(at), new Set([pick]))
    colors[index] = pick
    return pick
  }

  /** 新开一列：复用**最左空列**（列号稳定，斜线才不会满屏乱窜），没有空列才追加 */
  function openLane(at: string): number {
    const free = lanes.indexOf(null)
    const index = free >= 0 ? free : lanes.length
    if (free < 0) {
      lanes.push(null)
      colors.push(-1)
    }
    lanes[index] = at
    assignColor(index, at)
    return index
  }

  for (const commit of commits) {
    // ① 本提交落在哪一列：所有「正在等它」的列取最左一条（其余并过来 —— 见口径 3）
    const waiting: number[] = []
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.oid) waiting.push(i)
    }
    const lane = waiting.length > 0 ? waiting[0] : openLane(commit.oid)
    const color = assignColor(lane, commit.oid)
    const segments: GraphSegment[] = []

    // ①-① 从上方进入本行节点的那半段（分支头 / 窗口第一行没有它）
    if (waiting.length > 0) {
      segments.push({ x1: lane, y1: 0, x2: lane, y2: 0.5, color, curve: false })
    }
    // ①-② 其余在等本提交的列：斜线并到本列，并释放那一列
    for (const other of waiting) {
      if (other === lane) continue
      segments.push({ x1: other, y1: 0, x2: lane, y2: 0.5, color: colors[other], curve: true })
      lanes[other] = null
      colors[other] = -1
    }
    // ①-③ 穿过本行的列（不含本列）
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] !== null) {
        segments.push({ x1: i, y1: 0, x2: i, y2: 1, color: colors[i], curve: false })
      }
    }

    // ② 父：第一个父**顶替本列**（直线向下，颜色不变）；其余父各自落一列
    //    ⚠️ 同一个父写两次（不该发生但 git 允许）：按 oid 去重，别在同一列画两条线
    const placed = new Map<string, number>()
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        lanes[lane] = parent
        placed.set(parent, lane)
        segments.push({ x1: lane, y1: 0.5, x2: lane, y2: 1, color, curve: false })
        return
      }
      const known = placed.get(parent) ?? lanes.indexOf(parent)
      const target = known >= 0 ? known : openLane(parent)
      placed.set(parent, target)
      if (target !== lane) {
        segments.push({
          x1: lane,
          y1: 0.5,
          x2: target,
          y2: 1,
          color: colors[target],
          curve: true,
        })
      }
    })

    // ③ root（没有父）：本列到此为止，否则它会一直等着一个不存在的提交、把列占死
    if (commit.parents.length === 0) {
      lanes[lane] = null
      colors[lane] = -1
    }

    rows.push({ oid: commit.oid, lane, color, segments })
  }

  return { rows, laneCount: Math.max(1, lanes.length) }
}

/**
 * 可见窗口内的**连通分量**（并查集）。
 *
 * ⚠️ 只连**两端都在窗口内**的边：父提交没加载进来时，两个分支在图上就是看不出交集 —— 允许同色，
 * 这正是用户要的口径（「毫无交集的分支可以使用相同的颜色」）。
 */
function visibleComponents(commits: GraphCommit[]): Map<string, string> {
  const parent = new Map<string, string>()
  const inWindow = new Set(commits.map((c) => c.oid))
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    // 路径压缩（长历史下少走几步）
    let walk = x
    while (walk !== root) {
      const next = parent.get(walk) as string
      parent.set(walk, root)
      walk = next
    }
    return root
  }
  for (const commit of commits) {
    if (!parent.has(commit.oid)) parent.set(commit.oid, commit.oid)
    for (const p of commit.parents) {
      if (!inWindow.has(p)) continue
      if (!parent.has(p)) parent.set(p, p)
      const a = find(commit.oid)
      const b = find(p)
      if (a !== b) parent.set(a, b)
    }
  }
  const out = new Map<string, string>()
  for (const oid of parent.keys()) out.set(oid, find(oid))
  return out
}

// ==================== 引用（这条线是谁）====================

export type GraphRefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface GraphRef {
  /** 展示名（已剥掉 `refs/heads/` 这类前缀） */
  name: string
  kind: GraphRefKind
}

/**
 * `%D` 的引用列表 → 可展示的标签（全名的解析口径只有这一处）。
 *
 * 实测形态（`--decorate=full`）：`HEAD -> refs/heads/master` · `refs/heads/feat/x` ·
 * `refs/remotes/origin/master` · `tag: refs/tags/v1.1.55`（⚠️ 标签带 `tag: ` 前缀，轻量标签也一样）。
 * 顺序不可依赖（git 自己的排列），HEAD 那条**可能**排在最前，也可能不在首位。
 */
export function parseCommitRefs(refs: string[]): GraphRef[] {
  const out: GraphRef[] = []
  for (const raw of refs) {
    const isHead = raw.startsWith('HEAD -> ')
    const body = isHead ? raw.slice('HEAD -> '.length) : raw
    const tagged = body.startsWith('tag: ')
    const full = tagged ? body.slice('tag: '.length) : body
    let name: string
    let kind: GraphRefKind
    if (tagged || full.startsWith('refs/tags/')) {
      name = full.replace(/^refs\/tags\//, '')
      kind = 'tag'
    } else if (full.startsWith('refs/heads/')) {
      name = full.slice('refs/heads/'.length)
      kind = 'branch'
    } else if (full.startsWith('refs/remotes/')) {
      name = full.slice('refs/remotes/'.length)
      // ⚠️ `origin/HEAD` 是符号引用（与分支列表同一条口径：列出来只会误导），直接跳过
      if (/^[^/]+\/HEAD$/.test(name)) continue
      kind = 'remote'
    } else {
      // 游离 HEAD 与其它引用（refs/notes…）：原样显示，别吞（吞掉就等于骗人）
      name = full.replace(/^refs\//, '')
      kind = kindOfBare(full)
    }
    out.push({ name, kind: isHead ? 'head' : kind })
  }
  return out
}

/** 游离 HEAD（`%D` 只有 `HEAD`）等退化情形：没有前缀可剥时按最接近的一类展示 */
function kindOfBare(full: string): GraphRefKind {
  if (full === 'HEAD') return 'head'
  return 'branch'
}

/**
 * 引用种类的展示优先级（数字小 = 优先显示）。
 *
 * 实测反馈：「有本地的就显示本地的」—— 同一个提交几乎总是同时挂着 `master` 与 `origin/master`
 * 两条（推过就都有），两个都摆出来是噪声，而且没提供任何新信息。
 * 所以每行**只展示一个**：当前分支 → 本地分支 → 标签 → 远程跟踪分支。
 * ⚠️ 远程排在最后是因为它总是本地分支的倒影；标签排它前面是因为「这个提交被标了版」是本地事实。
 */
export const REF_PRIORITY: Record<GraphRefKind, number> = {
  head: 0,
  branch: 1,
  tag: 2,
  remote: 3,
}

/**
 * 一行只挑一个引用展示，剩下的进 `+n` 徽标（悬停给出它们是谁）。
 *
 * 同一档里取 `%D` 给出的**原顺序**的第一个（git 的输出顺序稳定：HEAD 在前）—— 所以这条函数是纯的、
 * 同输入同结果，不会因渲染次数而变。
 */
export function pickRowRefs(refs: GraphRef[]): { shown: GraphRef | null; hidden: GraphRef[] } {
  if (refs.length === 0) return { shown: null, hidden: [] }
  let best = 0
  for (let i = 1; i < refs.length; i++) {
    if (REF_PRIORITY[refs[i].kind] < REF_PRIORITY[refs[best].kind]) best = i
  }
  return {
    shown: refs[best],
    hidden: refs.filter((_, i) => i !== best),
  }
}

// ==================== 绘制指令 ====================

export interface GraphGeometry {
  laneWidth: number
  rowHeight: number
  padX: number
}

export type PaintOp =
  | {
      kind: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      color: number
      /** 线宽（px）—— 列多时列被压窄，它得跟着细 */
      width: number
    }
  | {
      kind: 'curve'
      x1: number
      y1: number
      x2: number
      y2: number
      color: number
      width: number
    }
  | {
      kind: 'dot'
      x: number
      y: number
      color: number
      head: boolean
      /** 半径（px）—— ⚠️ 直径 ≤ 列宽，否则相邻两列的点重叠 */
      r: number
      /** 空心（HEAD）那圈的描边宽度 */
      width: number
    }

/**
 * 可视区里的绘制指令（**像素坐标**，已减掉 `scrollTop`）—— canvas 侧只做 `moveTo/lineTo/arc`。
 *
 * 真虚拟化就在这一步：只算 `[scrollTop, scrollTop + viewHeight]` 覆盖到的行（canvas 天生只画可视区，
 * 不需要 DOM 版那套 `content-visibility`）。
 */
export function paintOps(
  layout: GraphLayout,
  opts: {
    scrollTop: number
    viewHeight: number
    geometry: GraphGeometry
    /** 当前 HEAD 指向的提交（画成空心加粗的节点） */
    headOid?: string | null
  },
): PaintOp[] {
  const { laneWidth: lw, rowHeight: rh, padX } = opts.geometry
  // 尺寸也在这一步算（几何一律不出本模块）：列宽一压窄，半径与线宽必须跟着缩
  const width = strokeWidth(lw)
  const r = nodeRadius(lw)
  const first = Math.max(0, Math.floor(opts.scrollTop / rh) - 1)
  const last = Math.min(
    layout.rows.length - 1,
    Math.ceil((opts.scrollTop + opts.viewHeight) / rh),
  )
  const ops: PaintOp[] = []
  for (let i = first; i <= last; i++) {
    const row = layout.rows[i]
    if (!row) continue
    const top = i * rh - opts.scrollTop
    const px = (lane: number): number => padX + lane * lw + lw / 2
    for (const seg of row.segments) {
      ops.push({
        kind: seg.curve ? 'curve' : 'line',
        x1: px(seg.x1),
        y1: top + seg.y1 * rh,
        x2: px(seg.x2),
        y2: top + seg.y2 * rh,
        color: seg.color,
        width,
      })
    }
    ops.push({
      kind: 'dot',
      x: px(row.lane),
      y: top + rh / 2,
      color: row.color,
      head: !!opts.headOid && row.oid === opts.headOid,
      r,
      width,
    })
  }
  return ops
}
