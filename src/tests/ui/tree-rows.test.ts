import { describe, expect, it } from 'vitest'
import {
  buildTreeRows,
  normalizeTreePath,
  parentDirOf,
  pasteDirFor,
  selectRangePaths,
  treeBaseName,
} from '@/ui/pages/chat/components/sidebar/tree-rows'
import type { DirState } from '@/ui/pages/chat/components/sidebar/tree-rows'

/**
 * 目录树扁平化 —— 虚拟列表的输入，必须只产出「当前可见」的行。
 *
 * 为什么单独守一条：虚拟滚动拿到的是一维数组，展开 / 折叠 / 懒加载 / 三种占位信息
 * 都靠这里的递归顺序表达；顺序或深度错了，界面上就是「行错位 / 子项挂错父节点」。
 */
describe('tree-rows', () => {
  const ROOT = 'C:/ws'

  function dirs(entries: Record<string, DirState>): Record<string, DirState> {
    return entries
  }

  it('无工作目录 → 没有行', () => {
    expect(buildTreeRows({ rootPath: '', dirs: {}, expanded: {} })).toEqual([])
  })

  it('根未展开 → 只有根行', () => {
    const rows = buildTreeRows({
      rootPath: ROOT,
      dirs: dirs({ [ROOT]: { entries: [{ name: 'a.ts', isDir: false }] } }),
      expanded: {},
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'node',
      path: ROOT,
      name: 'ws',
      isDir: true,
      depth: 0,
    })
  })

  it('展开根 → 根 + 子项，深度递增；未展开的子目录不下钻', () => {
    const rows = buildTreeRows({
      rootPath: ROOT,
      dirs: dirs({
        [ROOT]: {
          entries: [
            { name: 'src', isDir: true },
            { name: 'a.ts', isDir: false, size: 12 },
          ],
        },
        [`${ROOT}/src`]: { entries: [{ name: 'b.ts', isDir: false, size: 34 }] },
      }),
      expanded: { [ROOT]: true },
    })

    expect(rows.map((r) => [r.kind, 'path' in r ? r.path : r.code, r.depth])).toEqual([
      ['node', ROOT, 0],
      ['node', `${ROOT}/src`, 1],
      ['node', `${ROOT}/a.ts`, 1],
    ])
    // 体积随行带出（hover 右侧展示用）
    expect(rows[2]).toMatchObject({ size: 12 })
  })

  it('目录也展开时递归下钻，深度逐层 +1', () => {
    const rows = buildTreeRows({
      rootPath: ROOT,
      dirs: dirs({
        [ROOT]: { entries: [{ name: 'src', isDir: true }] },
        [`${ROOT}/src`]: {
          entries: [
            { name: 'deep', isDir: true },
            { name: 'b.ts', isDir: false },
          ],
        },
        [`${ROOT}/src/deep`]: { entries: [{ name: 'c.ts', isDir: false }] },
      }),
      expanded: { [ROOT]: true, [`${ROOT}/src`]: true, [`${ROOT}/src/deep`]: true },
    })

    expect(rows.map((r) => ('path' in r ? r.path : r.code))).toEqual([
      ROOT,
      `${ROOT}/src`,
      `${ROOT}/src/deep`,
      `${ROOT}/src/deep/c.ts`,
      `${ROOT}/src/b.ts`,
    ])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 2])
  })

  it('未加载 / 加载中 / 空目录 / 读取失败 各占一行占位', () => {
    const loading = buildTreeRows({
      rootPath: ROOT,
      dirs: {},
      expanded: { [ROOT]: true },
    })
    expect(loading[1]).toMatchObject({ kind: 'message', code: 'loading', depth: 1 })

    const empty = buildTreeRows({
      rootPath: ROOT,
      dirs: dirs({ [ROOT]: { entries: [] } }),
      expanded: { [ROOT]: true },
    })
    expect(empty[1]).toMatchObject({ kind: 'message', code: 'empty' })

    const failed = buildTreeRows({
      rootPath: ROOT,
      dirs: dirs({ [ROOT]: { error: 'permission denied' } }),
      expanded: { [ROOT]: true },
    })
    expect(failed[1]).toMatchObject({
      kind: 'message',
      code: 'error',
      text: 'permission denied',
    })
  })

  it('粘贴目标：目录贴进自己，文件贴进所在目录', () => {
    expect(pasteDirFor({ path: `${ROOT}/src`, isDir: true })).toBe(`${ROOT}/src`)
    expect(pasteDirFor({ path: `${ROOT}/src/a.ts`, isDir: false })).toBe(
      `${ROOT}/src`,
    )
  })

  it('路径工具：统一分隔符 / 取末段 / 取父目录', () => {
    expect(normalizeTreePath('C:\\ws\\src\\')).toBe('C:/ws/src')
    expect(treeBaseName('C:/ws/src/')).toBe('src')
    expect(treeBaseName('C:/')).toBe('C:')
    expect(parentDirOf('C:/ws/src/a.ts')).toBe('C:/ws/src')
    // 无目录部分时原样返回，避免拼出诡异的上级路径
    expect(parentDirOf('a.ts')).toBe('a.ts')
  })
})

/**
 * Shift 连选 —— 选中的是「可见行」区间，不是磁盘上的目录区間。
 * 折叠的节点不在 rows 里，绝不能入选（用户看不到它被选中）。
 */
describe('selectRangePaths', () => {
  const ROOT = 'C:/ws'
  const rows = buildTreeRows({
    rootPath: ROOT,
    dirs: {
      [ROOT]: {
        entries: [
          { name: 'src', isDir: true },
          { name: 'a.ts', isDir: false },
          { name: 'z.ts', isDir: false },
        ],
      },
      [`${ROOT}/src`]: { entries: [{ name: 'b.ts', isDir: false }] },
    },
    expanded: { [ROOT]: true, [`${ROOT}/src`]: true },
  })

  it('锚点到焦点：含两端的可见行路径（含子项）', () => {
    expect(selectRangePaths(rows, ROOT, `${ROOT}/a.ts`)).toEqual([
      ROOT,
      `${ROOT}/src`,
      `${ROOT}/src/b.ts`,
      `${ROOT}/a.ts`,
    ])
  })

  it('反向连选（焦点在锚点之前）顺序仍是从上到下', () => {
    expect(selectRangePaths(rows, `${ROOT}/z.ts`, `${ROOT}/src`)).toEqual([
      `${ROOT}/src`,
      `${ROOT}/src/b.ts`,
      `${ROOT}/a.ts`,
      `${ROOT}/z.ts`,
    ])
  })

  it('折叠后的子项不参与连选（以可见行为准）', () => {
    const collapsed = buildTreeRows({
      rootPath: ROOT,
      dirs: {
        [ROOT]: {
          entries: [
            { name: 'src', isDir: true },
            { name: 'a.ts', isDir: false },
          ],
        },
        [`${ROOT}/src`]: { entries: [{ name: 'b.ts', isDir: false }] },
      },
      expanded: { [ROOT]: true },
    })
    expect(selectRangePaths(collapsed, ROOT, `${ROOT}/a.ts`)).toEqual([
      ROOT,
      `${ROOT}/src`,
      `${ROOT}/a.ts`,
    ])
  })

  it('锚点已不可见（节点被折叠掉了）→ 只选焦点自身', () => {
    expect(selectRangePaths(rows, `${ROOT}/gone.ts`, `${ROOT}/a.ts`)).toEqual([
      `${ROOT}/a.ts`,
    ])
  })

  it('只有一行时也照常工作', () => {
    expect(selectRangePaths(rows, `${ROOT}/a.ts`, `${ROOT}/a.ts`)).toEqual([
      `${ROOT}/a.ts`,
    ])
  })
})
