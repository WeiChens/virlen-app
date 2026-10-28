/**
 * model-meshes.ts — 3D 预览「网格列表」的**纯数据层**（不 import three、不 import React、不碰 DOM）。
 *
 * 为什么单开一层：面板要做的事（逐网格显隐 / 单独显示 / 选中看统计 / 复制路径 / 按层级折叠）
 * 全是对「一列网格」的变换，而 `ModelScene` 只负责用 three 量出原始观测（`MeshSource`）并把可见性、
 * 选中落到真对象上。变换留在这里，用例就能在 node 里直接跑，不需要 WebGL 上下文。
 *
 * 四条口径：
 * 1. **id 只按遍历顺序发**（`mesh-0`…）：同一棵树重取一次不变，面板的选中 / 可见性都靠它
 *    对齐场景；用 `object.uuid` 会让「每次刷新行 key 都变」（展开态、选中态跟着跳）。
 * 2. **没名字是常态**（FBX 的子网格大量无名）：`path` 用语言中立的下标兜底（`车身 > #3`），
 *    「网格 3」这类要翻译的显示名留给视图层拼（铁律 7）。
 * 3. **不改入参、没变化就返回原数组**（引用相等）：面板靠它决定要不要重渲染，也省掉逐行 diff。
 * 4. **层级原样带上来**（`parents`：含**无名组**在内的每一层，`id` 由场景按遍历顺序发）：
 *    树形列表靠它还原「谁在谁里面」。只留名字的话同名兄弟组会粘成一组；顺手过滤空名的话
 *    无名组会被抹平一层（子网格直接挂到祖父下面）—— 两者都不是真的那棵树。
 *    `path` 仍是**只有名字**的那一串（`车身 > 车门 > #3`），不动已落地的复制口径。
 */

/** 可画对象的种类（与 `ModelScene.getStats()` 同口径：网格 / 点云 / 线都算「一项」） */
export type MeshKind = 'mesh' | 'points' | 'line'

/**
 * 树里的一层父级。`id` 由场景按**首次遇见顺序**发（`node-0`…）：同名兄弟组只能靠它区分，
 * 而名字链在这种情况下是重名的。`name` 允许为空（FBX / glTF 里大量无名组）。
 */
export interface MeshParent {
  /** 稳定分组 id（`node-3`）：同一棵树重取一次不变 */
  id: string
  /** 原始节点名（可能为空） */
  name: string
}

/** 列表里的一行，同时也是「隐藏 / 单独显示 / 选中」的目标 */
export interface MeshEntry {
  /** 稳定 id（`mesh-0` …）：由遍历序号算出，同一棵树重取一次不变 */
  id: string
  /** 遍历序号（无名网格的显示名用它，从 0 起） */
  index: number
  /** 原始节点名（常见为空） */
  name: string
  /** 从根到它这一路的节点名，顺序由外到内（含无名组；视图层只把它拼成 `path`） */
  parents: readonly MeshParent[]
  /** 缩进层级 = `parents.length`（顶层网格是 0） */
  depth: number
  /** 从根到它的名字链（`车身 > 车门`）：重名网格之间唯一的区别就在这 */
  path: string
  kind: MeshKind
  triangles: number
  vertices: number
  /** 材质数（多材质网格 = 多次绘制，一栏「材质 3」比逐条列出有用） */
  materials: number
  /** 模型自身单位下的包围盒尺寸（`ModelScene` 已经除掉了自动取景的缩放） */
  size: { x: number; y: number; z: number }
  /** 有效可见性（自己与所有祖先都可见才算：藏一个组 = 整棵子树都不画） */
  visible: boolean
}

/** 场景侧量好的原始观测（`ModelScene.listMeshes()` 采集，这里只做纯变换） */
export interface MeshSource {
  name: string
  /** 从根（不含模型根节点本身）到它父级的每一层，顺序由外到内（**含无名组**） */
  parents: readonly MeshParent[]
  kind: MeshKind
  triangles: number
  vertices: number
  materials: number
  size: { x: number; y: number; z: number }
  visible: boolean
}

/** 分组 id 前缀：场景侧按遍历顺序发号（`node-0`…），同一棵树重取一次不变 */
export const MESH_PARENT_ID_PREFIX = 'node-'

/** 根层的「父级」：顶层网格与顶层分组都挂在这下面（不对应任何 three 对象） */
const ROOT_GROUP_ID = ''

export const MESH_ID_PREFIX = 'mesh-'

/** 无名网格在 `path` 里的兜底：`#3` 语言中立，复制出去也能对回列表里的第 3 项 */
function leafNameOf(source: MeshSource, index: number): string {
  const name = source.name.trim()
  return name || `#${index + 1}`
}

/** `车身 > 车门 > #3`：`path` 是重名网格之间唯一的分辨依据，找不到名字时也要给出层级 */
export function meshPathOf(source: MeshSource, index: number): string {
  const parents = source.parents.map((parent) => parent.name.trim()).filter(Boolean)
  return [...parents, leafNameOf(source, index)].join(' > ')
}

/**
 * 观测 → 列表行。`index` 就是遍历序号，也就是 id 的序号 —— 场景侧的「id → 对象」映射
 * 是按同一个顺序建的（见 `ModelScene.listMeshes`），两边必须一起改。
 */
export function buildMeshEntries(sources: readonly MeshSource[]): MeshEntry[] {
  return sources.map((source, index) => ({
    id: `${MESH_ID_PREFIX}${index}`,
    index,
    name: source.name.trim(),
    // 逐层拷贝：面板只读它，但入参归场景所有，别让两边共享同一批对象
    parents: source.parents.map((parent) => ({ id: parent.id, name: parent.name })),
    depth: source.parents.length,
    path: meshPathOf(source, index),
    kind: source.kind,
    // 非索引几何的三角形数是 `顶点数 / 3`，可能是小数（点云 / 线由场景侧直接给 0）
    triangles: Math.round(source.triangles),
    vertices: source.vertices,
    materials: source.materials,
    size: { x: source.size.x, y: source.size.y, z: source.size.z },
    visible: source.visible,
  }))
}

// ------------------------------------------------------------------ 树形列表

/** 树形列表的一行：一个可折叠的分组，或者一个网格（`entry`） */
export type MeshRow =
  | {
      type: 'group'
      /** 场景发的分组 id（`node-3`）：折叠态与整组显隐都按它找下面的条目 */
      id: string
      /** 原始名（可能为空：视图层用「分组 n」兜底） */
      name: string
      /** 缩进层级（顶层组是 0） */
      depth: number
      /** 在整张列表里的第几个分组（从 1 起：无名组的「分组 n」用它，重取一次不变） */
      order: number
      /** 子树里的可画对象数与三角形合计（折叠起来时也看得出这一组的分量） */
      meshes: number
      triangles: number
      /** 子树可见性：全可见 true / 全隐藏 false / 混合 null（眼睛按钮给「半亮」） */
      visible: boolean | null
      /** 折叠了就不展开它的子树（只看这一行） */
      collapsed: boolean
    }
  | { type: 'mesh'; id: string; depth: number; entry: MeshEntry }

/** 子元素：分组（先建成骨架，行里再带聚合数字）或一个网格 */
type GroupChild = { type: 'group'; id: string } | { type: 'mesh'; entry: MeshEntry }

interface MeshTree {
  /** 父级分组 id（'' = 根层）→ 按遍历顺序排好的子元素 */
  children: Map<string, GroupChild[]>
  /** 分组 id → 名字与层级（名字是在**第一次遇到**时记下的） */
  groups: Map<string, { name: string; depth: number }>
}

/**
 * 行 → 树骨架。只按 `parents` 的 id 链落层级：条目本来就是遍历序（深度优先先序），
 * 所以同一父级下的子元素天然按场景里的顺序排好，不需要再排序。
 */
function buildTree(entries: readonly MeshEntry[]): MeshTree {
  const children = new Map<string, GroupChild[]>()
  const groups = new Map<string, { name: string; depth: number }>()
  const push = (parentId: string, child: GroupChild): void => {
    const list = children.get(parentId)
    if (list) list.push(child)
    else children.set(parentId, [child])
  }
  for (const entry of entries) {
    let parentId = ROOT_GROUP_ID
    entry.parents.forEach((parent, depth) => {
      if (!groups.has(parent.id)) {
        groups.set(parent.id, { name: parent.name, depth })
        push(parentId, { type: 'group', id: parent.id })
      }
      parentId = parent.id
    })
    push(parentId, { type: 'mesh', entry })
  }
  return { children, groups }
}

/**
 * 行 → 树形列表的行（深度优先先序，折叠的分组不展开子树）。
 *
 * 折叠态由调用方给（`collapsed` 里是分组 id 的集合），这里只读不写 —— 纯函数才好测，
 * 面板的 state 也就只有「哪些组折了」这一件事。
 */
export function buildMeshRows(
  entries: readonly MeshEntry[],
  collapsed: ReadonlySet<string> = new Set<string>(),
): MeshRow[] {
  const { children, groups } = buildTree(entries)
  /** 每个分组的聚合数字（深树只算一遍：不缓存就是 O(深度 × 网格数)） */
  const totals = new Map<string, { meshes: number; triangles: number; visible: number }>()
  const totalOf = (groupId: string): { meshes: number; triangles: number; visible: number } => {
    const cached = totals.get(groupId)
    if (cached) return cached
    let meshes = 0
    let triangles = 0
    let visible = 0
    for (const child of children.get(groupId) ?? []) {
      if (child.type === 'mesh') {
        meshes += 1
        triangles += child.entry.triangles
        if (child.entry.visible) visible += 1
        continue
      }
      const sub = totalOf(child.id)
      meshes += sub.meshes
      triangles += sub.triangles
      visible += sub.visible
    }
    const result = { meshes, triangles, visible }
    totals.set(groupId, result)
    return result
  }

  const rows: MeshRow[] = []
  let order = 0
  const walk = (parentId: string): void => {
    for (const child of children.get(parentId) ?? []) {
      if (child.type === 'mesh') {
        const { entry } = child
        rows.push({ type: 'mesh', id: entry.id, depth: entry.depth, entry })
        continue
      }
      const info = groups.get(child.id)
      const total = totalOf(child.id)
      const isCollapsed = collapsed.has(child.id)
      order += 1
      rows.push({
        type: 'group',
        id: child.id,
        name: info?.name ?? '',
        depth: info?.depth ?? 0,
        order,
        meshes: total.meshes,
        triangles: total.triangles,
        // 混合态（藏了一部分）给 null：眼睛按钮靠它显示「半亮」，点一下是「全部点亮」
        visible: total.visible === total.meshes ? true : total.visible === 0 ? false : null,
        collapsed: isCollapsed,
      })
      if (!isCollapsed) walk(child.id)
    }
  }
  walk(ROOT_GROUP_ID)
  return rows
}

/**
 * 初始折叠态：**只展开第一层**（顶层分组展开，里面再套的组一律折起来）。
 *
 * 深模型的树动辄四五层、几百行：全展开等于一屏全是行首缩进，第一眼反而看不出结构。
 */
export function defaultCollapsedGroups(entries: readonly MeshEntry[]): ReadonlySet<string> {
  const collapsed = new Set<string>()
  for (const entry of entries) {
    entry.parents.forEach((parent, depth) => {
      if (depth >= 1) collapsed.add(parent.id)
    })
  }
  return collapsed
}

/** 改一行的可见性；值没变时返回原数组（面板据此跳过重渲染） */
export function withVisibility(
  entries: readonly MeshEntry[],
  id: string,
  visible: boolean,
): readonly MeshEntry[] {
  const target = entries.find((entry) => entry.id === id)
  if (!target || target.visible === visible) return entries
  return entries.map((entry) => (entry.id === id ? { ...entry, visible } : entry))
}

/**
 * 整组显隐：把这一组**子树里的每一个网格**都设成同一状态。
 *
 * 落的是逐个网格的 `object.visible`（场景侧的 `setMeshVisible`），分组对象本身一概不碰 ——
 * 「藏一个组」在 three 里本来是父级 `visible` 的事，但那会让我们再维护一套「哪层是谁藏的」，
 * 而条目里的 `visible` 已经是**有效可见性**，两套状态一并存就会互相打脸。
 */
export function withGroupVisibility(
  entries: readonly MeshEntry[],
  groupId: string,
  visible: boolean,
): readonly MeshEntry[] {
  let changed = false
  const next = entries.map((entry) => {
    if (entry.visible === visible) return entry
    if (!entry.parents.some((parent) => parent.id === groupId)) return entry
    changed = true
    return { ...entry, visible }
  })
  return changed ? next : entries
}

/** 「单独显示」：只留这一项可见；本来就只剩它时返回原数组 */
export function onlyVisible(entries: readonly MeshEntry[], id: string): readonly MeshEntry[] {
  if (!entries.some((entry) => entry.id === id)) return entries
  if (entries.every((entry) => entry.visible === (entry.id === id))) return entries
  return entries.map((entry) => (entry.visible === (entry.id === id) ? entry : {
    ...entry,
    visible: entry.id === id,
  }))
}

/** 「显示全部」：全都可见时返回原数组 */
export function allVisible(entries: readonly MeshEntry[]): readonly MeshEntry[] {
  if (entries.every((entry) => entry.visible)) return entries
  return entries.map((entry) => (entry.visible ? entry : { ...entry, visible: true }))
}
