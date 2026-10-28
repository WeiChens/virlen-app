// @vitest-environment node
/**
 * 3D 预览「网格列表」的纯数据层（`model-meshes.ts`）：不碰 three、不碰 DOM，直接在 node 里跑。
 *
 * 守五件事：
 * 1. **id 只按遍历序号发**（`mesh-0`…）：面板的选中 / 可见性都靠它对齐场景，
 *    所以「同一份观测重取一次 id 不变」是硬约束；
 * 2. **无名网格有语言中立的兜底**：FBX 子网格大量没有名字，`path` 要给到 `车身 > #3`
 *    （`#n` 不翻译，复制出去也能对回列表第 n 行），要翻译的显示名留给视图层；
 * 3. **没变化就返回原数组**（引用相等）：面板据此跳过重渲染，`commitMeshes` 也靠它省掉逐行下发；
 * 4. **输出数据口径**：三角形取整（非索引几何是 `顶点数 / 3`，会带小数）、不改入参；
 * 5. **树形列表只按父级链还原层级**（含无名组、同名兄弟组不粘连），聚合数字与折叠都算在这里 ——
 *    视图层不再自己走一遍 three 的对象树。
 */
import { describe, expect, it } from 'vitest'
import {
  allVisible,
  buildMeshEntries,
  buildMeshRows,
  defaultCollapsedGroups,
  meshPathOf,
  onlyVisible,
  withGroupVisibility,
  withVisibility,
  type MeshParent,
  type MeshSource,
} from '@/ui/pages/chat/components/workspace-file/model-meshes'

function parent(id: string, name: string): MeshParent {
  return { id, name }
}

function source(overrides: Partial<MeshSource> = {}): MeshSource {
  return {
    name: 'body',
    parents: [],
    kind: 'mesh',
    triangles: 12,
    vertices: 8,
    materials: 1,
    size: { x: 1, y: 2, z: 3 },
    visible: true,
    ...overrides,
  }
}

describe('buildMeshEntries', () => {
  it('id 与序号来自遍历顺序，同一份观测重取一次不变', () => {
    const sources = [source({ name: 'a' }), source({ name: 'b' })]
    const first = buildMeshEntries(sources)
    const second = buildMeshEntries(sources)

    expect(first.map((entry) => entry.id)).toEqual(['mesh-0', 'mesh-1'])
    expect(second.map((entry) => entry.id)).toEqual(['mesh-0', 'mesh-1'])
    expect(first.map((entry) => entry.index)).toEqual([0, 1])
  })

  it('三角形取整（非索引几何的 顶点数 / 3 会带小数）', () => {
    expect(buildMeshEntries([source({ triangles: 10 / 3 })])[0].triangles).toBe(3)
  })

  it('无名网格：path 用 `#序号` 兜底，name 保持为空（显示名的翻译留给视图层）', () => {
    const [entry] = buildMeshEntries([
      source({ name: '   ', parents: [parent('node-0', '车身'), parent('node-1', '')] }),
    ])

    expect(entry.name).toBe('')
    expect(entry.path).toBe('车身 > #1')
    // 层级照旧带上来（无名那一层不能被抹掉）：树形列表靠它缩进
    expect(entry.depth).toBe(2)
    expect(entry.parents.map((item) => item.id)).toEqual(['node-0', 'node-1'])
  })

  it('path 是从外到内的名字链（重名网格只靠它区分）', () => {
    expect(meshPathOf(source({ name: '车门', parents: [parent('node-0', '车身')] }), 0)).toBe(
      '车身 > 车门',
    )
  })

  it('不改入参（size 是拷贝：面板改它不该污染场景侧的观测）', () => {
    const input = source()
    const [entry] = buildMeshEntries([input])
    entry.size.x = 99
    expect(input.size.x).toBe(1)
  })
})

describe('树形列表', () => {
  /** 车架（顶层）/ 车身 > 车门 > 窗户 / 轮子组 > 轮子 —— 三层套娃 + 两个顶层网格 */
  const entries = buildMeshEntries([
    source({ name: '车架' }),
    source({ name: '车门', parents: [parent('node-0', '车身')] }),
    source({
      name: '窗户',
      parents: [parent('node-0', '车身'), parent('node-1', '车门')],
    }),
    source({ name: '轮子', parents: [parent('node-2', '轮子组')] }),
  ])

  const namesOf = (rows: ReturnType<typeof buildMeshRows>): string[] =>
    rows.map((row) => (row.type === 'group' ? `[${row.name}]` : row.entry.name))

  it('按父级链还原层级：分组行在前、子项紧随其后，深度与遍历顺序一致', () => {
    const rows = buildMeshRows(entries)

    expect(namesOf(rows)).toEqual(['车架', '[车身]', '车门', '[车门]', '窗户', '[轮子组]', '轮子'])
    // 顶层的网格 / 分组是 0 层，子项逐层加一
    expect(
      rows.map((row) => row.depth),
    ).toEqual([0, 0, 1, 1, 2, 0, 1])
  })

  it('分组行带子树合计：网格数与三角形数（折起来时就看这一行）', () => {
    const rows = buildMeshRows(entries)
    const body = rows[1]
    const door = rows[3]

    expect(body.type === 'group' && body.meshes).toBe(2)
    expect(body.type === 'group' && body.triangles).toBe(24)
    expect(door.type === 'group' && door.meshes).toBe(1)
  })

  it('折叠的分组不展开子树（只看这一行，行数随之减少）', () => {
    const rows = buildMeshRows(entries, new Set(['node-0']))

    expect(namesOf(rows)).toEqual(['车架', '[车身]', '[轮子组]', '轮子'])
    expect(rows[1].type === 'group' && rows[1].collapsed).toBe(true)
  })

  it('混合态：组里藏了一部分是 null（全亮 true / 全藏 false）', () => {
    const [frame, door, window, wheel] = entries
    const partial = buildMeshRows([
      frame,
      door,
      { ...window, visible: false },
      wheel,
    ])
    const allHidden = buildMeshRows([
      frame,
      { ...door, visible: false },
      { ...window, visible: false },
      wheel,
    ])

    expect(partial[1].type === 'group' && partial[1].visible).toBe(null)
    expect(allHidden[1].type === 'group' && allHidden[1].visible).toBe(false)
  })

  it('分组按出现顺序编号（无名组的「分组 n」用它，视图层只负责翻译）', () => {
    const rows = buildMeshRows(
      buildMeshEntries([
        source({ name: 'a', parents: [parent('node-0', '')] }),
        source({ name: 'b', parents: [parent('node-1', '车身')] }),
      ]),
    )

    // 无名组名留在空串里：名字是原文，兜底文案归视图层（铁律 7）
    expect(rows[0].type === 'group' && rows[0].name).toBe('')
    expect(rows[0].type === 'group' && rows[0].order).toBe(1)
    expect(rows[2].type === 'group' && rows[2].order).toBe(2)
  })

  it('默认只展开第一层：顶层组不折，里面再套的组都折起来', () => {
    expect([...defaultCollapsedGroups(entries)]).toEqual(['node-1'])
  })

  it('没有分组的模型：行与条目一一对应（纯平列表不多出一层壳）', () => {
    const flat = buildMeshEntries([source({ name: 'a' }), source({ name: 'b' })])
    const rows = buildMeshRows(flat)

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.type === 'mesh')).toBe(true)
  })
})

describe('可见性变换', () => {
  const entries = buildMeshEntries([
    source({ name: 'a' }),
    source({ name: 'b', visible: false }),
    source({ name: 'c' }),
  ])

  it('withVisibility：只改目标行，且值没变时返回原数组', () => {
    const next = withVisibility(entries, 'mesh-0', false)
    expect(next).not.toBe(entries)
    expect(next.map((entry) => entry.visible)).toEqual([false, false, true])
    // 已经是 false 了：不该造一个新数组（面板会白重渲染一次）
    expect(withVisibility(entries, 'mesh-1', false)).toBe(entries)
    // 不存在的 id 也不造数组
    expect(withVisibility(entries, 'mesh-9', false)).toBe(entries)
  })

  it('withGroupVisibility：整组一起改，组外的行不动，没变化返回原数组', () => {
    const nested = buildMeshEntries([
      source({ name: 'a', parents: [parent('node-0', 'G')] }),
      source({ name: 'b', parents: [parent('node-0', 'G'), parent('node-1', 'H')] }),
      source({ name: 'c' }),
    ])

    const hidden = withGroupVisibility(nested, 'node-0', false)
    expect(hidden.map((entry) => entry.visible)).toEqual([false, false, true])
    // 子分组里的网格也算在这一组里（按子树算，不是只算直接子级）
    expect(withGroupVisibility(nested, 'node-1', false).map((entry) => entry.visible)).toEqual([
      true,
      false,
      true,
    ])
    // 全都已经是这个状态 / 组不存在：都返回原数组
    expect(withGroupVisibility(hidden, 'node-0', false)).toBe(hidden)
    expect(withGroupVisibility(nested, 'node-9', false)).toBe(nested)
  })

  it('onlyVisible：「单独显示」只留一项，其余全藏', () => {
    const next = onlyVisible(entries, 'mesh-2')
    expect(next.map((entry) => entry.visible)).toEqual([false, false, true])
    // 本来就只剩它可见：返回原数组
    expect(onlyVisible(next, 'mesh-2')).toBe(next)
    // 不存在的 id：原样返回（不能把整棵树都藏了）
    expect(onlyVisible(entries, 'mesh-9')).toBe(entries)
  })

  it('allVisible：全部点亮；本来就全亮时返回原数组', () => {
    const next = allVisible(entries)
    expect(next.every((entry) => entry.visible)).toBe(true)
    expect(allVisible(next)).toBe(next)
  })
})
