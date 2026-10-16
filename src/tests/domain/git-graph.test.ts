/**
 * 提交图的纯函数用例（`domain/git/graph.ts`）。
 *
 * 为什么这一份这么细：Canvas 在 jsdom 里**没有 2D 上下文**，界面用例只能验到「canvas 存在、
 * 属性对、`getContext` 被调过」；图的正确性（列分配 / 配色 / 坐标）全部落在纯函数上 ——
 * 这里少一条，线上就是「图看着有点怪」而没人能查。
 *
 * 七组：
 * 1. **列分配**：线性 / 分叉合并 / 重复父 / 窗口边界（父没加载进来）；
 * 2. **配色**：同一分量内不重复、毫无交集可复用（用户口径）；
 * 3. **追加不变式**：`前 N 行只由前 N 行决定` —— 加载更多不会让已经画好的部分跳一下；
 * 4. **引用解析**：`%D` 的全名 → 展示名（`tag: ` 前缀、`HEAD -> ` 前缀、`origin/HEAD` 要跳过）；
 * 5. **行内让位宽度**（`rowExtent` → `graphGeometry().rowGutters`）：每行只按**本行**画到的列留空，
 *    且列宽取**整份布局**那一份 —— 少算一列或用错列宽，线就压在字上（canvas 在行之上）；
 * 6. **密度与总宽**：列多时列宽变窄、节点直径不超列宽（不重叠）、总宽的软上限；
 * 7. **绘制指令**：只算可视区（真虚拟化）+ 坐标口径 + 半径/线宽在指令里 + 与 `theme.scss` 的两个镜像值。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GRAPH_PAD_X,
  GRAPH_PALETTE_FALLBACK,
  GRAPH_ROW_H,
  LANE_W,
  MAX_GRAPH_W,
  MIN_LANE_W,
  NODE_R,
  PALETTE_SIZE,
  graphGeometry,
  graphWidth,
  laneWidth,
  layoutGraph,
  nodeRadius,
  paintOps,
  parseCommitRefs,
  pickRowRefs,
  rowExtent,
  rowGutter,
  strokeWidth,
  type GraphCommit,
} from '@/domain/git'

/** 造提交：`c('M', ['C', 'B'])` = M 的父是 C 与 B（列表顺序 = 新 → 旧） */
function c(oid: string, parents: string[] = []): GraphCommit {
  return { oid, parents }
}

/** 行内坐标的浮点比较（0 / 0.5 / 1） */
const seg = (x1: number, y1: number, x2: number, y2: number, color: number, curve = false) => ({
  x1,
  y1,
  x2,
  y2,
  color,
  curve,
})

describe('提交图 · 列分配', () => {
  it('线性历史：一条直线、一个颜色；首行没有「从上方进来」的那半段', () => {
    const { rows, laneCount } = layoutGraph([c('a', ['b']), c('b', ['c']), c('c')])

    expect(laneCount).toBe(1)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(new Set(rows.map((r) => r.color))).toEqual(new Set([0]))
    // 首行：只有「向下到父」的半段（0.5 → 1）
    expect(rows[0].segments).toEqual([seg(0, 0.5, 0, 1, 0)])
    // 中间行：先接上面（0 → 0.5），再往下到父
    expect(rows[1].segments).toEqual([seg(0, 0, 0, 0.5, 0), seg(0, 0.5, 0, 1, 0)])
    // root：只有接上面那半段（没有父就别画向下的线）
    expect(rows[2].segments).toEqual([seg(0, 0, 0, 0.5, 0)])
  })

  it('分叉 + 合并（菱形）：第二条父线是新列、合并处斜线回到本列', () => {
    const { rows, laneCount } = layoutGraph([
      c('M', ['C', 'B']),
      c('C', ['A']),
      c('B', ['A']),
      c('A'),
    ])

    expect(laneCount).toBe(2)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0])
    // M：第一条父留在本列（直线向下），第二条父开新列（斜线 0.5@0 → 1@1，用**新列的颜色**）
    expect(rows[0].segments).toEqual([seg(0, 0.5, 0, 1, 0), seg(0, 0.5, 1, 1, 1, true)])
    // C：接上面 + 穿过本行的第 1 列（另一条分支的竖线）+ 向下到父
    expect(rows[1].segments).toContainEqual(seg(1, 0, 1, 1, 1))
    // B 也在等 A（两条列同时期待同一个提交）：它自己的向下线仍是本列
    expect(rows[2].segments).toContainEqual(seg(1, 0.5, 1, 1, 1, false))
    // A：两条列都等它 → 取最左那条，另一条用斜线并过来（颜色沿用被并掉那条列的色）
    expect(rows[3].lane).toBe(0)
    expect(rows[3].segments).toContainEqual(seg(1, 0, 0, 0.5, 1, true))
  })

  it('重复父（同一 oid 写两次）：只画一条线，不占两列', () => {
    const { rows, laneCount } = layoutGraph([c('M', ['A', 'A', 'B']), c('A'), c('B')])

    // M 的线：本列向下 + B 那条斜线 —— 第二个 'A' 不该再画一条（否则同列上出现两条重复线）
    expect(rows[0].segments).toEqual([seg(0, 0.5, 0, 1, 0), seg(0, 0.5, 1, 1, 1, true)])
    expect(laneCount).toBe(2)
  })

  it('窗口边界：父还没加载进来 → 底部留一条开口线（不是「到此为止」）', () => {
    const { rows } = layoutGraph([c('a', ['NOT_LOADED'])])

    // 只有向下的半段：线在行底部断开，界面靠「加载更多」把它接上
    expect(rows[0].segments).toEqual([seg(0, 0.5, 0, 1, 0)])
    expect(rows[0].segments.some((s) => s.y1 === 0)).toBe(false)
  })

  it('合并后的列会被释放并复用（最左空列优先，列号不会一直膨胀）', () => {
    // M 开两列 → C 合回 → 之后的新分支头应当复用回到第 1 列，而不是开到第 2 列
    const { rows, laneCount } = layoutGraph([
      c('M', ['C', 'B']),
      c('C', ['B']),
      c('B', ['A']),
      c('X'), // 另一条独立分支的头（窗口里的第二个「起点」）
      c('A'),
    ])

    expect(laneCount).toBe(2)
    expect(rows[3].lane).toBe(1)
  })
})

describe('提交图 · 配色（用户口径：有交集必不同色、毫无交集可同色）', () => {
  it('同一行里并排的竖线颜色互不相同（并排同色 = 分不清哪条是哪条）', () => {
    // 三条并行分支（都从 M 分出去）：每一行活跃的列都必须是不同色
    const { rows } = layoutGraph([
      c('M', ['A', 'B', 'C']),
      c('A', []),
      c('B', []),
      c('C', []),
    ])
    for (const row of rows) {
      // 竖线（`curve === false`）一条 = 一列；**本行节点自己那一列单独加**（它的竖线就是本列）
      const others = row.segments
        .filter((s) => !s.curve && s.x1 !== row.lane)
        .map((s) => s.color)
      const laneColors = [row.color, ...others]
      expect(new Set(laneColors).size).toBe(laneColors.length)
    }
    // 第一条父线与 M 同色（同一条线的延续，不是新分支）—— 一列一色，不是一提交一色
    expect(rows[1].color).toBe(rows[0].color)
    // 另外两条分支是新列 → 新色
    expect(rows[2].color).not.toBe(rows[0].color)
    expect(rows[3].color).not.toBe(rows[0].color)
  })

  it('毫无交集（窗口内没有共同提交）的两条线可以同色 —— 一前一后出现时复用同一色号', () => {
    // 两条各自独立的链：第一条走完释放了列，第二条复用同一列、并拿到同一个起始色
    const { rows } = layoutGraph([c('x1', []), c('y1', [])])
    expect(rows[0].color).toBe(0)
    expect(rows[1].color).toBe(0)
  })

  it('同一分量里被释放过的色号不会马上被下一个新列捡走（有交集的历史用不同色区分）', () => {
    // M 开出第二条分支（色 1）→ 它并回主干（列被释放）→ 之后 X 再开新列（Z）
    const { rows } = layoutGraph([
      c('M', ['C', 'B']),
      c('C', ['B']),
      c('B', ['X']),
      c('X', ['Y', 'Z']),
      c('Y', []),
      c('Z', []),
    ])
    // Y 是 X 的第一个父 → 留在本列（与本列同色，这是一条线的延续，不是新分支）
    expect(rows[4].lane).toBe(0)
    expect(rows[4].color).toBe(rows[3].color)
    // Z 是新开的列：拿到的色既不与**活跃列**撞（0），也不捡被释放过的那个（1）
    expect(rows[5].lane).toBe(1)
    expect([rows[3].color, 1]).not.toContain(rows[5].color)
  })

  it('列数超过调色板时按列号绕（不崩、不出 undefined 色）', () => {
    const parents = Array.from({ length: PALETTE_SIZE + 2 }, (_, i) => `p${i}`)
    const { rows } = layoutGraph([c('M', parents), ...parents.map((p) => c(p))])
    for (const row of rows) {
      expect(row.color).toBeGreaterThanOrEqual(0)
      expect(row.color).toBeLessThan(PALETTE_SIZE)
    }
  })
})

describe('提交图 · 追加不变式', () => {
  it('前 N 行的布局只由前 N 行决定（加载更多不会让已画好的部分跳一下）', () => {
    const page1 = [c('M', ['C', 'B']), c('C', ['A'])]
    const page2 = [c('B', ['A']), c('A')]
    const first = layoutGraph(page1)
    const both = layoutGraph([...page1, ...page2])

    // ⚠️ 行本身必须逐字段相等 —— 这是「整份重算」能成立的依据（算法只向后看）
    expect(both.rows.slice(0, page1.length)).toEqual(first.rows)
    // 但**列数**是全局量：追加可能让画布变宽（宽度变化只发生在「加载更多」那一刻）
    expect(both.laneCount).toBeGreaterThanOrEqual(first.laneCount)
  })

  it('全量重算 == 两页拼起来一次算（分页不该有第二份状态）', () => {
    const rows = [c('M', ['C', 'B']), c('C', ['A']), c('B', ['A']), c('A')]
    expect(layoutGraph(rows)).toEqual(layoutGraph([...rows]))
  })
})

describe('提交图 · 引用解析（%D 的全名）', () => {
  it('四类引用各归其位（含 `HEAD -> ` 与 `tag: ` 两个前缀）', () => {
    expect(
      parseCommitRefs([
        'HEAD -> refs/heads/master',
        'refs/remotes/origin/master',
        'tag: refs/tags/v1.0',
        'refs/heads/feat/x',
      ]),
    ).toEqual([
      { name: 'master', kind: 'head' },
      { name: 'origin/master', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
      { name: 'feat/x', kind: 'branch' },
    ])
  })

  it('`refs/remotes/<remote>/HEAD` 是符号引用 —— 跳过（与分支列表同一条口径）', () => {
    expect(parseCommitRefs(['refs/remotes/origin/HEAD'])).toEqual([])
    // 但形似而非符号引用的不跳（`origin/HEAD~` 不是合法引用名，这里只管 `origin/HEAD` 本身）
    expect(parseCommitRefs(['refs/remotes/origin/HEADER'])).toEqual([
      { name: 'origin/HEADER', kind: 'remote' },
    ])
  })

  it('游离 HEAD 与其它引用原样显示（不吞数据）', () => {
    expect(parseCommitRefs(['HEAD'])).toEqual([{ name: 'HEAD', kind: 'head' }])
    expect(parseCommitRefs(['refs/notes/commits'])).toEqual([
      { name: 'notes/commits', kind: 'branch' },
    ])
    expect(parseCommitRefs([])).toEqual([])
  })

  it('本地分支名可以含 `/`（`feat/0914-responses-api`）—— 全名解析不会把它当成远程分支', () => {
    expect(parseCommitRefs(['refs/heads/feat/0914-responses-api'])).toEqual([
      { name: 'feat/0914-responses-api', kind: 'branch' },
    ])
  })

  it('每行只挑一个展示：当前分支 > 本地分支 > 标签 > 远程（有本地的就不展示远程）', () => {
    // 实测反馈：「有本地的就显示本地的」—— `master` 与 `origin/master` 几乎总是一起出现
    const picked = pickRowRefs([
      { name: 'origin/master', kind: 'remote' },
      { name: 'master', kind: 'branch' },
    ])
    expect(picked.shown).toEqual({ name: 'master', kind: 'branch' })
    expect(picked.hidden).toEqual([{ name: 'origin/master', kind: 'remote' }])

    // 当前分支优先于其它本地分支（它就是「我在哪」）
    expect(
      pickRowRefs([
        { name: 'feat/x', kind: 'branch' },
        { name: 'master', kind: 'head' },
      ]).shown,
    ).toEqual({ name: 'master', kind: 'head' })

    // 标签优先于远程跟踪分支（「这个提交被标了版」是本地事实，远程只是倒影）
    expect(
      pickRowRefs([
        { name: 'origin/main', kind: 'remote' },
        { name: 'v1.0', kind: 'tag' },
      ]).shown,
    ).toEqual({ name: 'v1.0', kind: 'tag' })

    // 只有远程时也要显示（否则这一行只剩一个孤零零的 `+1`）
    expect(pickRowRefs([{ name: 'origin/main', kind: 'remote' }]).shown).toEqual({
      name: 'origin/main',
      kind: 'remote',
    })
  })

  it('同一档里取原顺序的第一个（纯函数：同输入同结果，不随渲染次数变）', () => {
    const refs = [
      { name: 'b1', kind: 'branch' as const },
      { name: 'b2', kind: 'branch' as const },
      { name: 'r1', kind: 'remote' as const },
    ]
    expect(pickRowRefs(refs).shown).toEqual({ name: 'b1', kind: 'branch' })
    expect(pickRowRefs(refs).hidden.map((r) => r.name)).toEqual(['b2', 'r1'])
    expect(pickRowRefs([])).toEqual({ shown: null, hidden: [] })
  })
})

describe('提交图 · 绘制指令', () => {
  const geometry = { laneWidth: LANE_W, rowHeight: GRAPH_ROW_H, padX: 6 }
  const linear = layoutGraph([c('a', ['b']), c('b', ['c']), c('c')])

  it('坐标口径：列心 = padX + 列号 × 列宽 + 列宽/2；节点在行中线', () => {
    const ops = paintOps(linear, { scrollTop: 0, viewHeight: GRAPH_ROW_H, geometry })
    const dot = ops.find((o) => o.kind === 'dot')
    expect(dot).toMatchObject({ x: 6 + LANE_W / 2, y: GRAPH_ROW_H / 2, head: false })

    // 第 1 行（索引 1）的两半段：上半 30 → 45（接上面），下半 45 → 60（连到父）
    expect(ops).toContainEqual({
      kind: 'line',
      x1: 6 + LANE_W / 2,
      y1: GRAPH_ROW_H,
      x2: 6 + LANE_W / 2,
      y2: GRAPH_ROW_H * 1.5,
      color: 0,
      width: strokeWidth(LANE_W),
    })
    expect(ops).toContainEqual({
      kind: 'line',
      x1: 6 + LANE_W / 2,
      y1: GRAPH_ROW_H * 1.5,
      x2: 6 + LANE_W / 2,
      y2: GRAPH_ROW_H * 2,
      color: 0,
      width: strokeWidth(LANE_W),
    })
  })

  it('HEAD 的节点是空心（`head: true`），别的提交是实心', () => {
    // 可视高度给满 3 行，否则第 3 行在屏外、根本不会生成指令（这本身就是虚拟化在生效）
    const ops = paintOps(linear, {
      scrollTop: 0,
      viewHeight: GRAPH_ROW_H * 3,
      geometry,
      headOid: 'b',
    })
    const dots = ops.filter((o) => o.kind === 'dot')
    expect(dots).toHaveLength(3)
    expect(dots.filter((d) => d.kind === 'dot' && d.head)).toHaveLength(1)
    expect(dots.filter((d) => d.kind === 'dot' && !d.head)).toHaveLength(2)
  })

  it('只算可视区（真虚拟化）：一万行滚到中间也只产出几行指令', () => {
    const many = layoutGraph(
      Array.from({ length: 10000 }, (_, i) => c(`c${i}`, i < 9999 ? [`c${i + 1}`] : [])),
    )
    const ops = paintOps(many, {
      scrollTop: 5000 * GRAPH_ROW_H,
      viewHeight: GRAPH_ROW_H * 10,
      geometry,
    })
    // 可视 10 行 + 上下各 1 行余量 = 12 行左右（每行 2 段 + 1 个点）
    expect(ops.filter((o) => o.kind === 'dot').length).toBeLessThanOrEqual(13)
    expect(ops.length).toBeLessThan(45)
  })

  it('空列表不产出任何指令（空仓库：给空态，不画空白画布）', () => {
    expect(paintOps(layoutGraph([]), { scrollTop: 0, viewHeight: 100, geometry })).toEqual([])
  })
})

describe('提交图 · 行内让位宽度（rowExtent）', () => {
  it('只用到第一列的行 = 一列宽（不是整窗口最宽那一行）', () => {
    const layout = layoutGraph([c('a', ['b']), c('b', ['c']), c('c')])
    expect(layout.rows.map(rowExtent)).toEqual([1, 1, 1])
    // 换算成像素取 `graphGeometry().rowGutters`（与画线、画布宽同一个出口）；
    // 这个样本 laneCount = 1，所以与 `graphWidth(1)` 数值相同 —— 密集窗口才分得开（见下一组）
    expect(graphGeometry(layout).rowGutters).toEqual([
      graphWidth(1),
      graphWidth(1),
      graphWidth(1),
    ])
  })

  it('分叉 / 合并的行按「线跨到哪一列」占宽（斜线也算本行的）', () => {
    const { rows, laneCount } = layoutGraph([
      c('M', ['C', 'B']),
      c('C', ['A']),
      c('B', ['A']),
      c('A'),
    ])
    // M 本列直线 + 斜线开到第 1 列；C / B 有第 1 列的竖线穿过 → 四行都占 2 列
    expect(rows.map(rowExtent)).toEqual([2, 2, 2, 2])
    expect(laneCount).toBe(2)
  })

  it('另一条线 root 之后，后面的行缩回一列（留位是逐行的，不是整窗口的）', () => {
    const { rows, laneCount } = layoutGraph([c('M', ['A', 'B']), c('B', ['Z']), c('Z'), c('A')])
    // 前三行都被 B 那一支（第 1 列）占着；B 的支线 root 之后，A 这一行只剩自己 → 1 列
    expect(rows.map(rowExtent)).toEqual([2, 2, 2, 1])
    expect(laneCount).toBe(2)
  })

  it('任意一行：让位宽度 = 本行最右一列 + 1，且像素宽度盖得住本行最右那个点', () => {
    const layout = layoutGraph([
      c('M', ['C', 'B']),
      c('C', ['A']),
      c('B', ['A']),
      c('A'),
      c('X', ['Y', 'Z']),
      c('Y'),
      c('Z'),
    ])
    const { laneWidth: lw, rowGutters } = graphGeometry(layout)
    layout.rows.forEach((row, i) => {
      const right = Math.max(row.lane, ...row.segments.flatMap((s) => [s.x1, s.x2]))
      expect(rowExtent(row)).toBe(right + 1)
      expect(rowExtent(row)).toBeLessThanOrEqual(layout.laneCount)
      // ⚠️ 这条是真正的约束：让位宽度不够，**线就压在字上**（canvas 在行之上，见 style.scss）
      expect(rowGutters[i]).toBeGreaterThanOrEqual(
        GRAPH_PAD_X + right * lw + lw / 2 + nodeRadius(lw),
      )
    })
  })

  it('列宽取**整份布局**那一份 —— 按本行占几列反算会让密集窗口每行白空 60–85px', () => {
    // 20 条分支逐个合进主干（每合一条就多挂一条并行的线）+ 一条主干尾巴
    // ⇒ laneCount = 21、窗口列宽被压到 7px，而「按本行反算」在 11 列时仍是设计值 14px
    const BRANCHES = 20
    const commits: GraphCommit[] = [c('b0')]
    let tip = 'b0'
    for (let i = 1; i <= 2; i++) {
      commits.push(c(`t${i}`, [tip]))
      tip = `t${i}`
    }
    for (let i = 0; i < BRANCHES; i++) commits.push(c(`f${i}`, [tip]))
    for (let i = 0; i < BRANCHES; i++) {
      commits.push(c(`m${i}`, [tip, `f${i}`]))
      tip = `m${i}`
    }
    commits.reverse() // 新 → 旧（`--date-order` 的口径）

    const layout = layoutGraph(commits)
    const { laneWidth: lw, rowGutters } = graphGeometry(layout)
    const byRowLaneWidth = layout.rows.map((row) => graphWidth(rowExtent(row)))

    expect(layout.laneCount).toBe(BRANCHES + 1)
    expect(lw).toBe(7)

    // 中间那一行（挂着 10 条分支的线）：旧写法 166px，现在 12 + 11 × 7 = 89px
    const mid = layout.rows.findIndex((row) => rowExtent(row) === 11)
    expect(mid).toBeGreaterThan(-1)
    expect(byRowLaneWidth[mid]).toBe(166)
    expect(rowGutters[mid]).toBe(GRAPH_PAD_X * 2 + 11 * lw)

    // 主干尾巴（只剩一列）：旧写法 26px，现在 19px
    const tail = layout.rows.length - 1
    expect(rowExtent(layout.rows[tail])).toBe(1)
    expect(byRowLaneWidth[tail]).toBe(26)
    expect(rowGutters[tail]).toBe(GRAPH_PAD_X * 2 + lw)

    // 任何一行都不许比「按本行反算」更宽（把「两套几何各自演化」钉死），
    // 且留位是**逐行**算的（不是整窗口一个值）
    rowGutters.forEach((w, i) => expect(w).toBeLessThanOrEqual(byRowLaneWidth[i]))
    expect(new Set(rowGutters).size).toBeGreaterThan(1)
  })

  it('画线 / 画布宽 / 行内空位三处同源（`graphGeometry` 与 `laneWidth`/`graphWidth` 是一个口径）', () => {
    const parents = Array.from({ length: 30 }, (_, i) => `p${i}`)
    const layout = layoutGraph([c('M', parents), ...parents.map((p) => c(p))])
    const geo = graphGeometry(layout)
    expect(geo.laneWidth).toBe(laneWidth(layout.laneCount))
    expect(geo.canvasWidth).toBe(graphWidth(layout.laneCount))
    expect(geo.rowGutters).toEqual(layout.rows.map((r) => rowGutter(r, geo.laneWidth)))
  })
})

describe('提交图 · 密度（列多时的可读下限）', () => {
  const COUNTS = [1, 3, 8, 11, 12, 17, 20, 30, 40, 41, 63, 100]

  it('节点直径不超过列宽（否则相邻两列的点重叠成一团）+ 列宽不低于下限', () => {
    for (const n of COUNTS) {
      const lw = laneWidth(n)
      expect(nodeRadius(lw) * 2).toBeLessThanOrEqual(lw)
      expect(lw).toBeGreaterThanOrEqual(MIN_LANE_W)
    }
  })

  it('列宽 14px 时仍是设计尺寸（r=4 / 线宽 2）—— 压缩只在列多时发生', () => {
    expect(nodeRadius(LANE_W)).toBe(NODE_R)
    expect(strokeWidth(LANE_W)).toBe(2)
    // 线宽也不许超过列宽的一半（并排两条线不能挨在一起）
    for (const n of COUNTS) expect(strokeWidth(laneWidth(n)) * 2).toBeLessThanOrEqual(laneWidth(n))
  })

  it('总宽软上限：40 列以内恒 ≤ MAX_GRAPH_W + 两侧内边距', () => {
    for (let n = 1; n <= 40; n++) {
      expect(graphWidth(n)).toBeLessThanOrEqual(MAX_GRAPH_W + GRAPH_PAD_X * 2)
    }
    // 旧实现的坑：列宽下限取 6px，40 列以后就变成 6px × 列数、线性暴涨（63 列 = 390px 空白墙）
    expect(graphWidth(63)).toBeLessThan(6 * 63 + GRAPH_PAD_X * 2)
  })

  it('超过软上限能装的列数后，列宽停在 MIN_LANE_W（宽度只随列数线性增长）', () => {
    expect(laneWidth(41)).toBe(MIN_LANE_W)
    expect(laneWidth(100)).toBe(MIN_LANE_W)
    expect(graphWidth(100)).toBe(MIN_LANE_W * 100 + GRAPH_PAD_X * 2)
  })

  it('半径与线宽写进绘制指令（canvas 侧一个几何数都不算）', () => {
    const layout = layoutGraph([c('a', ['b']), c('b')])
    const ops = paintOps(layout, {
      scrollTop: 0,
      viewHeight: GRAPH_ROW_H * 2,
      geometry: { laneWidth: MIN_LANE_W, rowHeight: GRAPH_ROW_H, padX: GRAPH_PAD_X },
    })
    for (const op of ops) expect(op.width).toBe(strokeWidth(MIN_LANE_W))
    expect(ops.find((o) => o.kind === 'dot')).toMatchObject({ r: nodeRadius(MIN_LANE_W) })
  })
})

describe('提交图 · 几何常量与 theme.scss 的镜像', () => {
  const scss = readFileSync(
    resolve(process.cwd(), 'src/ui/styles/theme.scss'),
    'utf8',
  )
  const darkAt = scss.indexOf("[data-theme='dark']")
  const decls = [...scss.matchAll(/--git-graph-(\d)\s*:\s*([^;]+);/g)].map((m) => ({
    lane: Number(m[1]),
    value: m[2].trim(),
    at: m.index ?? 0,
  }))
  const pick = (after: boolean): string[] =>
    decls
      .filter((d) => (after ? d.at > darkAt : d.at < darkAt))
      .sort((a, b) => a.lane - b.lane)
      .map((d) => d.value)

  it('列宽：列少用满 14px，列多压窄但不裁列（最窄 `MIN_LANE_W`）', () => {
    expect(laneWidth(1)).toBe(LANE_W)
    expect(laneWidth(3)).toBe(LANE_W)
    expect(laneWidth(40)).toBe(MIN_LANE_W)
    expect(graphWidth(3)).toBe(LANE_W * 3 + 12)
    expect(graphWidth(0)).toBe(LANE_W + 12)
  })

  it('行高令牌与 `GRAPH_ROW_H` 是同一个数（错开 1px 就是整张图逐行错位）', () => {
    const rowH = /--git-graph-row-h\s*:\s*([^;]+);/.exec(scss)?.[1]?.trim()
    expect(rowH).toBe(`${GRAPH_ROW_H}px`)
    const laneW = /--git-graph-lane-w\s*:\s*([^;]+);/.exec(scss)?.[1]?.trim()
    expect(laneW).toBe(`${LANE_W}px`)
  })

  it('两套调色板都齐 8 色；暗色那份与 `GRAPH_PALETTE_FALLBACK` 逐个相等', () => {
    const light = pick(false)
    const dark = pick(true)
    expect(light).toHaveLength(PALETTE_SIZE)
    expect(dark).toHaveLength(PALETTE_SIZE)
    for (const v of [...light, ...dark]) expect(v).toMatch(/^#[0-9a-f]{6}$/)
    // 同一档里不许有重复色（重复 = 两条并排的线同色，等于没配色）
    expect(new Set(light).size).toBe(PALETTE_SIZE)
    expect(new Set(dark).size).toBe(PALETTE_SIZE)
    // 亮 / 暗是两套（暗色档不能照抄亮色档：深底上 #0969da 几乎看不见）
    expect(light).not.toEqual(dark)
    // ⚠️ canvas 读不到 CSS 变量时的兵底必须就是暗色档那一套，否则暗色主题上画亮色的线（§11.53 ⑭）
    expect(dark).toEqual([...GRAPH_PALETTE_FALLBACK])
  })
})
