// @vitest-environment node
/**
 * 差异内核（`utils/diff`）—— 全项目「左右对比」的**唯一实现**（jsdiff 的 diffLines + 组内 diffChars，
 * 与 xwjc-app 的 `VersionCompareDetailPage/diff.js` 同一套）。
 *
 * 覆盖的都是「错了很难受、且看起来还挺对」的地方：
 * - 一行里改几个字 → **一行 modified + 字符级片段**，不是整行删除 + 整行新增；
 * - **换行本身就是变更**：行中插入 / 删除换行要标 `↵`，另一侧那一行是「续行」（行号留空），
 *   绝不能把换行后的内容算成整段替换；
 * - `startLine` 偏移（`edit_file` 显示的是文件里的绝对行号）；
 * - 空侧（`null` 与空串同义）；
 * - 横向滚动的宽度口径（`maxDiffWidthCh`）：宽字符 / 制表符一律**往宽了估**（估窄会裁掉内容）；
 * - 性能闸：超大改动组退化成整行红绿（**不许**退化成「没有差异」）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildDiffRows,
  diffStats,
  maxDiffWidthCh,
  normalizeDiffRows,
  NL_MARK,
  type DiffRow,
} from '@/utils/diff'

/** 拼一段以换行结尾的文本（末尾换行不算一行，见内核） */
const text = (...lines: string[]): string =>
  lines.length === 0 ? '' : lines.join('\n') + '\n'

/** 某一行某一侧拼回的纯文本（去掉展示用的换行标记） */
function sideText(row: DiffRow, side: 'left' | 'right'): string {
  return row[side]
    .map((p) => (p.value === NL_MARK ? '' : p.value))
    .join('')
}

describe('buildDiffRows', () => {
  it('相同文本：全是 equal，两侧行号一致且从 1 起', () => {
    const rows = buildDiffRows(text('a', 'b'), text('a', 'b'))
    expect(rows.map((r) => r.type)).toEqual(['equal', 'equal'])
    expect(rows.map((r) => r.leftLineNo)).toEqual([1, 2])
    expect(rows.map((r) => r.rightLineNo)).toEqual([1, 2])
    expect(rows[0].left).toEqual([{ type: 'equal', value: 'a' }])
  })

  it('末尾新增一行：added，左半为空（渲染时留空行盒，不是一行空白文本）', () => {
    const rows = buildDiffRows(text('a'), text('a', 'b'))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({
      type: 'added',
      leftLineNo: null,
      rightLineNo: 2,
      left: [],
      right: [{ type: 'added', value: 'b' }],
    })
  })

  it('删除一行：removed，右半为空', () => {
    const rows = buildDiffRows(text('a', 'b', 'c'), text('a', 'c'))
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual({
      type: 'removed',
      leftLineNo: 2,
      rightLineNo: null,
      left: [{ type: 'removed', value: 'b' }],
      right: [],
    })
    // 删除之后的行号各自连续
    expect(rows[2].leftLineNo).toBe(3)
    expect(rows[2].rightLineNo).toBe(2)
  })

  it('一行里改几个字 → **一行 modified + 字符级片段**，不是整行删除 + 整行新增', () => {
    const rows = buildDiffRows(text('const a = 1'), text('const a = 2'))
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('modified')
    // 只把变了的那一个字符标出来
    expect(rows[0].left).toEqual([
      { type: 'equal', value: 'const a = ' },
      { type: 'removed', value: '1' },
    ])
    expect(rows[0].right).toEqual([
      { type: 'equal', value: 'const a = ' },
      { type: 'added', value: '2' },
    ])
    expect(rows[0].leftLineNo).toBe(1)
    expect(rows[0].rightLineNo).toBe(1)
  })

  it('行中插入换行：标 ↵，左侧那一行续行（行号留空），不是整段替换', () => {
    const rows = buildDiffRows(text('ab'), text('a', 'b'))
    expect(rows).toHaveLength(2)

    expect(rows[0].type).toBe('modified')
    expect(sideText(rows[0], 'left')).toBe('a')
    expect(rows[0].right).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'added', value: NL_MARK },
    ])

    // 左侧是同一行的续行 → 行号留空；右侧是新的一行
    expect(rows[1].type).toBe('equal')
    expect(rows[1].leftLineNo).toBeNull()
    expect(rows[1].rightLineNo).toBe(2)
    expect(sideText(rows[1], 'left')).toBe('b')
    expect(sideText(rows[1], 'right')).toBe('b')
  })

  it('删掉换行：左侧打 ↵，右侧续行', () => {
    const rows = buildDiffRows(text('a', 'b'), text('ab'))
    expect(rows[0].left).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'removed', value: NL_MARK },
    ])
    expect(rows[1].leftLineNo).toBe(2)
    expect(rows[1].rightLineNo).toBeNull()
  })

  it('整行新增 / 删除时换行标记**自成一段**（不能并进相邻片段）', () => {
    // ⚠️ 并成 `'a↵'` 后，视图层「value === NL_MARK」的判定全部失效，↵ 会漏进 Monaco 正文与剪贴板
    const added = buildDiffRows(null, text('a', 'b'))
    expect(added[0].right).toEqual([
      { type: 'added', value: 'a' },
      { type: 'added', value: NL_MARK },
    ])
    const removed = buildDiffRows(text('a', 'b'), null)
    expect(removed[0].left).toEqual([
      { type: 'removed', value: 'a' },
      { type: 'removed', value: NL_MARK },
    ])
    for (const row of [...added, ...removed]) {
      for (const part of [...row.left, ...row.right]) {
        if (part.value !== NL_MARK) expect(part.value).not.toContain(NL_MARK)
      }
    }
  })

  it('startLine 让行号从文件里的真实行号开始（edit_file 用绝对行号）', () => {
    const rows = buildDiffRows(text('a', 'b'), text('a', 'b'), 10)
    expect(rows.map((r) => r.leftLineNo)).toEqual([10, 11])
    expect(rows.map((r) => r.rightLineNo)).toEqual([10, 11])
  })

  it('空侧：`null` 与空串同义（这一侧没有内容）', () => {
    expect(buildDiffRows(null, text('x'))).toHaveLength(1)
    expect(buildDiffRows(text('x'), null)[0].type).toBe('removed')
    expect(buildDiffRows(null, null)).toEqual([])
    expect(buildDiffRows('', '')).toEqual([])
  })

  it('中间的空行是真行，不能被丢掉', () => {
    expect(buildDiffRows(null, 'a\n\nb')).toHaveLength(3)
  })
})

describe('diffStats', () => {
  it('按行统计：removed → 减少、added → 新增、modified 两侧各算一行', () => {
    const stats = diffStats(buildDiffRows(text('a', 'b', 'c'), text('a', 'B')))
    // a 不变；b → B 是 modified（两侧各一行）；c 被删除
    expect(stats).toEqual({
      delCount: 2,
      insCount: 1,
      modifiedCount: 1,
      equalCount: 1,
    })
  })

  it('无变化时全零', () => {
    expect(diffStats(buildDiffRows(text('a'), text('a')))).toEqual({
      delCount: 0,
      insCount: 0,
      modifiedCount: 0,
      equalCount: 1,
    })
  })
})

describe('normalizeDiffRows（历史消息里落库的老行模型）', () => {
  it('老模型 equal / delete / insert → 新模型，一行一段、内容与行号都不丢', () => {
    const rows = normalizeDiffRows([
      { type: 'equal', oldLine: 'a', newLine: 'a', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', oldLine: 'b', newLine: null, oldLineNum: 2, newLineNum: null },
      { type: 'insert', oldLine: null, newLine: 'B', oldLineNum: null, newLineNum: 2 },
    ])
    expect(rows).toEqual([
      {
        type: 'equal',
        leftLineNo: 1,
        rightLineNo: 1,
        left: [{ type: 'equal', value: 'a' }],
        right: [{ type: 'equal', value: 'a' }],
      },
      {
        type: 'removed',
        leftLineNo: 2,
        rightLineNo: null,
        left: [{ type: 'removed', value: 'b' }],
        right: [],
      },
      {
        type: 'added',
        leftLineNo: null,
        rightLineNo: 2,
        left: [],
        right: [{ type: 'added', value: 'B' }],
      },
    ])
  })

  it('新模型原样通过；省略行（gap）与脏数据被丢掉', () => {
    const fresh = {
      type: 'modified' as const,
      leftLineNo: 3,
      rightLineNo: 3,
      left: [{ type: 'equal' as const, value: 'x' }],
      right: [{ type: 'added' as const, value: 'y' }],
    }
    expect(normalizeDiffRows([fresh, { type: 'gap' }, null, 42])).toEqual([fresh])
  })

  it('早期落库的「标记并进相邻片段」形态会被拆开（否则 ↵ 会被当成正文）', () => {
    const rows = normalizeDiffRows([
      {
        type: 'added',
        leftLineNo: null,
        rightLineNo: 1,
        left: [],
        right: [{ type: 'added', value: `a${NL_MARK}` }],
      },
    ])
    expect(rows[0].right).toEqual([
      { type: 'added', value: 'a' },
      { type: 'added', value: NL_MARK },
    ])
  })

  it('不是数组（老消息里字段缺失）→ 空数组，不抛', () => {
    expect(normalizeDiffRows(undefined)).toEqual([])
    expect(normalizeDiffRows({})).toEqual([])
  })
})

describe('maxDiffWidthCh（横向滚动的宽度口径）', () => {
  it('取两侧里最宽的那一行（两列同宽 → 谁宽听谁的）', () => {
    const rows = buildDiffRows(
      text('short', 'x'.repeat(40)),
      text('short', 'y'.repeat(10)),
    )
    expect(maxDiffWidthCh(rows)).toBe(40)
  })

  it('宽字符算 2、制表符算 8（tab 走制表位）、换行标记算 1 —— 一律**往宽了估**', () => {
    const rows: DiffRow[] = [
      {
        type: 'removed',
        leftLineNo: 1,
        rightLineNo: null,
        left: [
          { type: 'equal', value: '中文两字' }, // 4 个宽字符 = 8
          { type: 'removed', value: '\t' }, // 1 个制表符 = 8（往宽估，宁多滚）
        ],
        right: [],
      },
    ]
    expect(maxDiffWidthCh(rows)).toBe(16)
  })

  it('省略间隔行（gap）不参与；空数组是 0', () => {
    const gapRow: { type: 'gap' } = { type: 'gap' }
    expect(maxDiffWidthCh([gapRow])).toBe(0)
    expect(maxDiffWidthCh([])).toBe(0)
  })

  it('同一份行数据反复问结果一致（原位 / 全屏两份实例各问一次）', () => {
    const rows = buildDiffRows(text('abc'), text('abcd'))
    expect(maxDiffWidthCh(rows)).toBe(maxDiffWidthCh(rows))
    expect(maxDiffWidthCh(rows)).toBe(4)
  })
})

describe('性能闸（参照实现没有，实测必须加）', () => {
  it('组内超大：退化成「整行红绿」，但**不许**退化成没有差异', () => {
    // 单行两侧各 6000 字符 → 改动组超过字符闸
    const long = 'x'.repeat(6000)
    const rows = buildDiffRows(text(`a${long}`), text(`b${long}`))
    expect(rows.map((r) => r.type)).toEqual(['removed', 'added'])
    expect(rows[0].leftLineNo).toBe(1)
    expect(rows[1].rightLineNo).toBe(1)
  })

  it('全文件改动量超大：公共前后缀仍逐行对齐，中间整段「先删后增」', () => {
    // 每行都不同 → 编辑距离远超行级闸（实测：不加闸这段要 1.8 s）
    const head = Array.from({ length: 3 }, (_, i) => `same head ${i}`)
    const tail = Array.from({ length: 3 }, (_, i) => `same tail ${i}`)
    const midOld = Array.from({ length: 1200 }, (_, i) => `old body ${i} aaaa`)
    const midNew = Array.from({ length: 1200 }, (_, i) => `new body ${i} bbbb`)

    const rows = buildDiffRows(
      [...head, ...midOld, ...tail].join('\n') + '\n',
      [...head, ...midNew, ...tail].join('\n') + '\n',
    )

    expect(rows.filter((r) => r.type === 'equal')).toHaveLength(6)
    expect(rows.filter((r) => r.type === 'removed')).toHaveLength(1200)
    expect(rows.filter((r) => r.type === 'added')).toHaveLength(1200)
    // 前后缀是真实相等行：行号仍是文件里的绝对行号
    expect(rows[0]).toMatchObject({ type: 'equal', leftLineNo: 1, rightLineNo: 1 })
    expect(rows[rows.length - 1]).toMatchObject({
      type: 'equal',
      leftLineNo: 1206,
      rightLineNo: 1206,
    })
  })
})
