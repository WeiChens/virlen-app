/**
 * 提交图的布局 / 配色 / 绘制指令（纯函数，唯一实现）。
 * 本模块只产出坐标 + 尺寸，往 canvas 上涂是 GraphCanvas 的事。
 *
 * 四条静默出错的口径：
 * 1. 行高必须是固定像素，跟字号缩放会逐行错位；
 * 2. 连通分量只按窗口内可见的边算（窗口外交汇看不出来 → 允许同色）；
 * 3. 同一列可能被多个子提交期待，必须合并成一条线；
 * 4. 让位宽度逐行算，但列宽必须用整窗口那一份（否则密集时白空 60–85px，或线压在字上）。
 */

/** 一行提交在图里需要的东西。 */
export interface GraphCommit {
  oid: string
  parents: string[]
}

/**
 * 一段线（行内坐标）：x = 列号，y 用行内比例（0 = 行顶边、1 = 底边），换行高不用重算布局。
 */
export interface GraphSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  color: number
  /** 分叉 / 合并的斜线用曲线；贯穿竖线为 false */
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
  /** 窗口内最大列数（决定画布宽度） */
  laneCount: number
}

/** 调色板大小（颜色在 theme.scss 的 --git-graph-1..8）。 */
export const PALETTE_SIZE = 8

/**
 * 读不到 CSS 变量时的兜底（测试环境）。必须与 theme.scss 的暗色档逐个相等，由单测扫文本钉住。
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
 * 行高（px），与 SCSS 的 --git-graph-row-h 必须同一个数（由单测扫文本钉住）。
 * 硬编码像素：坐标按它算；30 = padding 5+5 + 最大档字号 13px × 1.5。
 */
export const GRAPH_ROW_H = 30

/** 列宽上限（px） */
export const LANE_W = 14
/**
 * 图列总宽软上限：列多就压窄（列不互相挤），压到 MIN_LANE_W 为止。
 * 下限不能取大值：max(6, MAX/n)*n 在 40 列后线性暴涨。
 */
export const MAX_GRAPH_W = 160
/** 列宽下限：再窄线与点就糊在一起 */
export const MIN_LANE_W = 4
/** 画布左右内边距（第一个点不要贴着边框） */
export const GRAPH_PAD_X = 6
/** 节点半径上限（列密时按 nodeRadius 缩） */
export const NODE_R = 4

/** 列宽：列少用满 LANE_W，列多压窄以守住 MAX_GRAPH_W（不裁列），最窄 MIN_LANE_W。 */
export function laneWidth(laneCount: number): number {
  const n = Math.max(1, laneCount)
  return Math.max(MIN_LANE_W, Math.min(LANE_W, Math.floor(MAX_GRAPH_W / n)))
}

/**
 * 画布宽度（列宽 × 列数 + 内边距）。别拿它算行内让位（按本行列数反算列宽会白空），
 * 行内空位一律取 graphGeometry().rowGutters。
 */
export function graphWidth(laneCount: number): number {
  return laneWidth(laneCount) * Math.max(1, laneCount) + GRAPH_PAD_X * 2
}

/**
 * 节点半径：列宽够时是 NODE_R，压窄时按比例缩（直径必须 ≤ 列宽，否则相邻两列的点重叠）。
 */
export function nodeRadius(laneWidth: number): number {
  return Math.max(1.2, Math.min(NODE_R, laneWidth * 0.3))
}

/** 线宽：14px 列宽时 2px，压窄时跟着变细（上限列宽一半）。 */
export function strokeWidth(laneWidth: number): number {
  return Math.max(1, Math.min(2, laneWidth / 7))
}

/**
 * 一行的让位宽度（占几列）：节点列与所有线段列取最大 +1。线段已含穿越竖线与斜线，
 * 少算一列线就压在字上（canvas 在行之上）。
 */
export function rowExtent(row: GraphRow): number {
  let right = row.lane
  for (const s of row.segments) right = Math.max(right, s.x1, s.x2)
  return right + 1
}

/**
 * 一行的像素左空位。laneW 必须是整份布局的列宽（按本行列数反算会白空 60–85px）。
 */
export function rowGutter(row: GraphRow, laneW: number): number {
  return GRAPH_PAD_X * 2 + rowExtent(row) * laneW
}

/**
 * 整份布局的几何：画布宽 / 列宽 / 每行让位宽度唯一出口（三处必须同源，否则密集时会漂）。
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

// 布局

/**
 * 逐行推进的列分配（与 gitg / VS Code 同一套）。commits 必须已按「父不排在子之前」排好。
 */
export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const comp = visibleComponents(commits)
  /** 分量 → 已用色号（分量内不重复，分量间复用） */
  const compUsed = new Map<string, Set<number>>()
  /** 每列「正在期待的 oid」（null = 空列）与其色号 */
  const lanes: (string | null)[] = []
  const colors: number[] = []
  const rows: GraphRow[] = []

  const compOf = (oid: string): string => comp.get(oid) ?? oid

  /** 取色号：不碰活跃列已用色；列数超调色板才按列号绕 */
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

  /** 新开一列：复用最左空列（列号稳定，斜线才不会满屏乱窜） */
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
    // ① 本提交落在最左的等待列（其余并过来）
    const waiting: number[] = []
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.oid) waiting.push(i)
    }
    const lane = waiting.length > 0 ? waiting[0] : openLane(commit.oid)
    const color = assignColor(lane, commit.oid)
    const segments: GraphSegment[] = []

    // ①-① 从上方进入节点的半段（分支头 / 窗口第一行没有）
    if (waiting.length > 0) {
      segments.push({ x1: lane, y1: 0, x2: lane, y2: 0.5, color, curve: false })
    }
    // ①-② 其余等待列：斜线并到本列并释放
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

    // ② 第一个父顶替本列；其余父各自落一列（同 oid 不重复画线）
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

    // ③ root：本列到此为止，否则它会一直等着不存在的提交
    if (commit.parents.length === 0) {
      lanes[lane] = null
      colors[lane] = -1
    }

    rows.push({ oid: commit.oid, lane, color, segments })
  }

  return { rows, laneCount: Math.max(1, lanes.length) }
}

/**
 * 窗口内的连通分量（并查集）。只连两端都在窗口内的边：窗口外交汇看不出来 → 允许同色。
 */
function visibleComponents(commits: GraphCommit[]): Map<string, string> {
  const parent = new Map<string, string>()
  const inWindow = new Set(commits.map((c) => c.oid))
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    // 路径压缩
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

// 引用（这条线是谁）

export type GraphRefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface GraphRef {
  /** 展示名（已剥掉 refs/heads/ 之类前缀） */
  name: string
  kind: GraphRefKind
}

/**
 * %D 的引用列表 → 可展示标签。形态：HEAD -> refs/heads/x、refs/remotes/o/x、tag: refs/tags/v1。
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
      // origin/HEAD 是符号引用，与分支列表同口径：跳过
      if (/^[^/]+\/HEAD$/.test(name)) continue
      kind = 'remote'
    } else {
      // 游离 HEAD 与其它引用：原样显示，不吞
      name = full.replace(/^refs\//, '')
      kind = kindOfBare(full)
    }
    out.push({ name, kind: isHead ? 'head' : kind })
  }
  return out
}

/** 游离 HEAD（%D 只有 HEAD）等退化情形：按最接近的一类展示 */
function kindOfBare(full: string): GraphRefKind {
  if (full === 'HEAD') return 'head'
  return 'branch'
}

/**
 * 引用展示优先级（小 = 优先）：每行只展示一个，head → 分支 → 标签 → 远程。
 * 远程总在最后：它总是本地分支的倒影。
 */
export const REF_PRIORITY: Record<GraphRefKind, number> = {
  head: 0,
  branch: 1,
  tag: 2,
  remote: 3,
}

/** 一行只挑一个引用展示，剩下的进 +n；同档取原顺序第一个（纯函数，结果稳定）。 */
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

// 绘制指令

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
      /** 线宽（px），列多时跟着变细 */
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
      /** 半径（px），直径必须 ≤ 列宽 */
      r: number
      /** 空心（HEAD）那圈的描边宽度 */
      width: number
    }

/**
 * 可视区的绘制指令（像素坐标，已减 scrollTop），canvas 侧只做 moveTo/lineTo/arc。
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
  // 尺寸也在这里算：列宽一压窄，半径与线宽必须跟着缩
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
