// @vitest-environment node
/**
 * `edit_file` 的差异输入适配层（`EditFileMessage` 里的 `toMonacoDiffInput`）：行模型 → Monaco 的两份文本。
 *
 * 这是「片段视图 → 两份全文」的唯一转换点，守三件事：
 * 1. 折回来的文本必须与文件里的那一侧**逐字一致**（用真内核造行再折回去对照 —— 续行不得换行、
 *    换行标记 `↵` 不进文本）：差一个字，Monaco 就会把那一行显示成假的增删；
 * 2. 逐行行号映射把合成文本的行号还原成文件里的**绝对行号**（占位行不给号）；
 * 3. `⋯` 占位行**两侧都有**（否则会被 Monaco 算成一处新增/删除），且有了它行号就不连续 →
 *    列头不再写 `Ln a–b`（与 DOM 版「多处编辑不显示区间」同口径）。
 */
import { expect, it, vi } from 'vitest'

// 入口是 `.tsx`（里面有 JSX 与 Monaco 视图），本用例只看纯函数 —— 把 Monaco 那两层换成替身
vi.mock('@monaco-editor/react', () => {
  const Stub = (): null => null
  return { default: Stub, Editor: Stub, DiffEditor: Stub, loader: { config: () => {} } }
})
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: {},
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  toMonacoLang: (): string | undefined => undefined,
  default: (): null => null,
}))

import { toMonacoDiffInput } from '@/ui/pages/chat/components/tool-call/EditFileMessage'
import type { SideBySideRow } from '@/ui/pages/chat/components/message/SideBySideDiff'
import { buildDiffRows } from '@/utils/diff'

it('折回文本与文件里的那一侧一致：续行不换行、换行标记不进文本', () => {
  // 旧侧一行 `ab`；新侧两行 `a` / `b`（行中插了换行）—— 行模型里那第二行是**续行**（行号为 null）
  const rows = buildDiffRows('ab', 'a\nb', 5) as SideBySideRow[]
  expect(rows.some((r) => r.type !== 'gap' && r.leftLineNo === null)).toBe(true)

  const input = toMonacoDiffInput(rows)

  // 折回来必须是原来的两份文本：续行接在上一行后面（不换行），`↵` 只留在行模型里
  expect(input.oldText).toBe('ab')
  expect(input.newText).toBe('a\nb')

  // 行号：两侧都从文件里的第 5 行起；旧侧只有一行
  expect(input.lineNumbers.old(1)).toBe('5')
  expect(input.lineNumbers.old(2)).toBe('')
  expect(input.lineNumbers.new(1)).toBe('5')
  expect(input.lineNumbers.new(2)).toBe('6')

  // 单段连续 → 列头写区间
  expect(input.colHeaderNote.old).toBe('Ln 5–5')
  expect(input.colHeaderNote.new).toBe('Ln 5–6')
})

it('整行新增 / 删除的 ↵ 不进文本：折回来就是文件里的那几行', () => {
  // 回归：标记曾被并进相邻片段（`'a↵'`），下游按 `value === NL_MARK` 判定失效 → ↵ 进了 Monaco 正文，
  // 用户一眼看到红字里的 ↵、选中还能把它复制出去
  const input = toMonacoDiffInput(buildDiffRows(null, 'a\nb', 1) as SideBySideRow[])
  expect(input.oldText).toBe('')
  expect(input.newText).toBe('a\nb')

  const removed = toMonacoDiffInput(
    buildDiffRows('x\ny', null, 3) as SideBySideRow[],
  )
  expect(removed.oldText).toBe('x\ny')
  expect(removed.newText).toBe('')
})

it('多处编辑之间的省略行两侧都插占位，且列头不再写区间', () => {
  const rows = [
    {
      type: 'equal',
      leftLineNo: 3,
      rightLineNo: 3,
      left: [{ type: 'equal', value: 'a' }],
      right: [{ type: 'equal', value: 'a' }],
    },
    { type: 'gap' },
    {
      type: 'removed',
      leftLineNo: 20,
      rightLineNo: null,
      left: [{ type: 'removed', value: 'z' }],
      right: [],
    },
    {
      type: 'added',
      leftLineNo: null,
      rightLineNo: 20,
      left: [],
      right: [{ type: 'added', value: 'w' }],
    },
  ] as SideBySideRow[]

  const input = toMonacoDiffInput(rows)

  // ⚠️ 占位行两侧都要有（两边相同 = 未改动行）；只插一侧就会被算成一处新增/删除
  expect(input.oldText).toBe('a\n⋯\nz')
  expect(input.newText).toBe('a\n⋯\nw')
  // 占位行不给行号（它代表一段未知范围）
  expect(input.lineNumbers.old(2)).toBe('')
  expect(input.lineNumbers.new(2)).toBe('')
  expect(input.lineNumbers.old(3)).toBe('20')
  // 行号被省略行打断（3 → 20）→ 不写区间（写了反而误导）
  expect(input.colHeaderNote.old).toBeNull()
  expect(input.colHeaderNote.new).toBeNull()
})
