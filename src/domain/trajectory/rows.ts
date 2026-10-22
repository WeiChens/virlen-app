/**
 * 轨迹表 → 扁平显示行。
 *
 * 虚拟列表只认「一行一个高度」，所以轮头 / 组头 / 记录行必须摊平成一个数组
 * （而不是嵌套 JSX）。三种行高度固定，滚动条不会因为内容测量抖动 —— 轨迹表的
 * 每一行本来就是一行字，没必要做动态测量。
 *
 * 折叠只影响 `rows` 的内容，**不改行号**：记录的 `index` 是「它在会话里的位置」，
 * 折叠轮次后行号要跳号（`#3 → #9`），那正是我们想要的 —— 用户看到的是同一张地图。
 */
import type {
  TrajectoryGroup,
  TrajectoryRecord,
  TrajectoryTurn,
} from './types'

/** 轮头行高（sticky） */
export const TURN_ROW_HEIGHT = 34
/** 组头行高（「消息」/「第 N 步」） */
export const GROUP_ROW_HEIGHT = 24
/** 记录行高 */
export const RECORD_ROW_HEIGHT = 32

/** 扁平化后的一行 */
export type TrajectoryDisplayRow =
  | {
    kind: 'turn'
    /** 稳定 key（带 `turn:` 前缀，避免与记录 key 撞） */
    key: string
    turn: TrajectoryTurn
    /** 本轮是否收起（收起时轮头右侧显示「N 组 · M 行」） */
    collapsed: boolean
    height: number
  }
  | {
    kind: 'group'
    key: string
    group: TrajectoryGroup
    /** 该组是否属于一个已收起的轮（用于弱化渲染，理论上是 false） */
    turnKey: string
    height: number
  }
  | {
    kind: 'record'
    key: string
    record: TrajectoryRecord
    groupKey: string
    height: number
  }

export interface TrajectoryFlatOptions {
  /** 收起的轮次 key 集合（`TrajectoryTurn.key`） */
  collapsedTurns: ReadonlySet<string>
  /** 折叠所有工具行（只留「谁在什么时候说了什么」） */
  hideToolRecords?: boolean
}

export interface TrajectoryFlatResult {
  rows: TrajectoryDisplayRow[]
  /** `record.index` → `rows` 下标（时间轴 / 搜索命中后滚动定位用） */
  recordRowIndex: Map<number, number>
  /**
   * `record.key` → `rows` 下标。
   *
   * ⚠️ 定位必须走 key 而不能走 `index`：向前回补历史时整段记录会重新编号
   * （`#1` 变成 `#61`），用行号存下来的「选中 / 待滚到」目标会瞬间指向别的记录。
   * key 由消息 id / callId 组成，前插不会变。
   */
  recordRowIndexByKey: Map<string, number>
}

/**
 * 摊平轨迹。
 * @param turns `buildTrajectory` 的输出
 * @param options 折叠状态
 */
export function flattenTrajectory(
  turns: readonly TrajectoryTurn[],
  options: TrajectoryFlatOptions,
): TrajectoryFlatResult {
  const rows: TrajectoryDisplayRow[] = []
  const recordRowIndex = new Map<number, number>()
  const recordRowIndexByKey = new Map<string, number>()
  const hideToolRecords = options.hideToolRecords === true

  for (const turn of turns) {
    const collapsed = options.collapsedTurns.has(turn.key)
    rows.push({
      kind: 'turn',
      key: `row:${turn.key}`,
      turn,
      collapsed,
      height: TURN_ROW_HEIGHT,
    })
    if (collapsed) continue
    for (const group of turn.groups) {
      rows.push({
        kind: 'group',
        key: `row:${group.key}`,
        group,
        turnKey: turn.key,
        height: GROUP_ROW_HEIGHT,
      })
      for (const record of group.records) {
        if (hideToolRecords && record.kind === 'tool') continue
        recordRowIndex.set(record.index, rows.length)
        recordRowIndexByKey.set(record.key, rows.length)
        rows.push({
          kind: 'record',
          key: `row:${record.key}`,
          record,
          groupKey: group.key,
          height: RECORD_ROW_HEIGHT,
        })
      }
    }
  }

  return { rows, recordRowIndex, recordRowIndexByKey }
}

/** 统计一个轮里的记录数 / 组数（折叠态的轮头摘要用） */
export function turnSummary(turn: TrajectoryTurn): { groups: number; records: number } {
  let records = 0
  for (const group of turn.groups) records += group.records.length
  return { groups: turn.groups.length, records }
}
