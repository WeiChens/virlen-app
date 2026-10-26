// @vitest-environment node
/**
 * 侧边栏分组内的会话折叠：组内**既有未归档又有归档**时，归档的全部收进「展示全部」后面。
 *
 * 为什么要有这层：归档只是靠组内排序殿后（`listSessions`），混排的组里它们照样铺在最下面，
 * 把活跃会话挤到看不见的位置 —— 而「归档 = 暂时不想动它」本来该多看一层。
 *
 * 折叠规则抽成纯函数 `foldGroupSessions` 直接单测；「哪里用」用源码断言
 * （jsdom 里挂整个侧边栏要拖起工作目录树 / 技能列表，成本远大于收益，口径同 `sidebar-status-flag.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { foldGroupSessions } from '@/ui/pages/chat/components/sidebar/session-fold'

function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `本用例需要以 virlen-app 为工作目录运行：找不到 ${rel}（当前 cwd = ${process.cwd()}）`,
    )
  }
  return readFileSync(p, 'utf8')
}

const SIDEBAR = 'src/ui/pages/chat/components/sidebar/index.tsx'
const src = readProjectFile(SIDEBAR)

/** 最小会话：折叠只看归档标记 */
const s = (id: string, archived = false) => ({ id, archived })
const active = (n: number) =>
  Array.from({ length: n }, (_, i) => s(`a${i}`, false))
const ids = (list: { id: string }[]) => list.map((x) => x.id)

describe('foldGroupSessions —— 混排时归档全部进折叠', () => {
  it('2 条未归档 + 3 条归档 → 只铺未归档，按钮后面藏 3 条', () => {
    const folded = foldGroupSessions([
      s('a1'),
      s('a2'),
      s('z1', true),
      s('z2', true),
      s('z3', true),
    ])

    expect(ids(folded.visible)).toEqual(['a1', 'a2'])
    expect(folded.folded).toBe(true)
    expect(folded.hidden).toBe(3)
  })

  it('只有 1 条未归档 + 1 条归档也折：与条数阈值无关', () => {
    const folded = foldGroupSessions([s('a1'), s('z1', true)])

    expect(ids(folded.visible)).toEqual(['a1'])
    expect(folded.folded).toBe(true)
    expect(folded.hidden).toBe(1)
  })

  it('按标记折，不依赖「归档一定排在末尾」这个位置约定', () => {
    const folded = foldGroupSessions([s('z1', true), s('a1'), s('z2', true)])

    expect(ids(folded.visible)).toEqual(['a1'])
  })

  it('archived 缺省（老数据）= 未归档：不折也不算进折叠条数', () => {
    // 显式标注元素类型：缺省 `archived` 的字面量推不出可视字段
    const legacy: { id: string; archived?: boolean }[] = [{ id: 'a1' }, { id: 'a2' }]
    const folded = foldGroupSessions(legacy)

    expect(ids(folded.visible)).toEqual(['a1', 'a2'])
    expect(folded.folded).toBe(false)
  })
})

describe('foldGroupSessions —— 没有混排就不因归档折叠', () => {
  it('全归档：整组照铺（组已沉到列表尾部，再把内容藏起来只剩一个空分组）', () => {
    const folded = foldGroupSessions([s('z1', true), s('z2', true)])

    expect(ids(folded.visible)).toEqual(['z1', 'z2'])
    expect(folded.folded).toBe(false)
  })

  it('阈值边界：11 条全铺，12 条只铺前 10 条', () => {
    expect(foldGroupSessions(active(11)).visible).toHaveLength(11)
    expect(foldGroupSessions(active(11)).folded).toBe(false)

    const twelve = foldGroupSessions(active(12))
    expect(ids(twelve.visible)).toEqual(ids(active(10)))
    expect(twelve.folded).toBe(true)
    expect(twelve.hidden).toBe(2)
  })

  it('混排且未归档也超阈值：先折归档，再按 10 条截断', () => {
    const folded = foldGroupSessions([...active(12), s('z1', true)])

    expect(ids(folded.visible)).toEqual(ids(active(10)))
    expect(folded.folded).toBe(true)
    expect(folded.hidden).toBe(3) // 截断 2 条 + 归档 1 条
  })
})

describe('foldGroupSessions —— 展开态', () => {
  it('expanded → 全部（含归档），不再给按钮', () => {
    const all = [s('a1'), s('z1', true)]
    const folded = foldGroupSessions(all, true)

    expect(folded.visible).toBe(all) // 展开就是原数组，不额外拷一份
    expect(folded.folded).toBe(false)
    expect(folded.hidden).toBe(0)
  })

  it('空组：什么都不铺，也不给按钮', () => {
    expect(foldGroupSessions([])).toEqual({ visible: [], folded: false, hidden: 0 })
  })
})

describe('侧边栏接线：用折叠结果渲染，搜索时铺开', () => {
  it('渲染走 foldGroupSessions（旧的 `> 11` 分支已删）', () => {
    expect(src).toContain('foldGroupSessions(group.sessions, showAll || isSearching)')
    expect(src).toContain('{folded.visible.map(renderSession)}')
    expect(src).toContain('{folded.folded && (')
    expect(src).not.toContain('group.sessions.length > 11')
  })

  it('搜索时强制铺开：命中项可能正是被折叠的归档会话', () => {
    expect(src).toContain("isSearching={sessionKeyword !== ''}")
  })
})
