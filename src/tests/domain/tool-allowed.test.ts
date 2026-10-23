/**
 * 会话工具白名单过滤（三态语义）—— 引擎与轨迹检查器共用的唯一实现。
 *
 * 这三个分支各自都对应一次真实的线上事故形态：老数据缺 `allowedTools`、用户把工具全关、
 * 白名单只写一半。写错任何一条，模型看到的工具就和界面显示的不一致。
 */
import { describe, expect, it } from 'vitest'
import { filterAllowedToolDefs } from '@/domain/tools'

const DEFS = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]
const names = (list: readonly { name: string }[]): string[] => list.map((d) => d.name)

describe('filterAllowedToolDefs', () => {
  it('undefined = 没有白名单 → 全部工具，顺序不变', () => {
    const out = filterAllowedToolDefs(DEFS, undefined)
    expect(names(out)).toEqual(['alpha', 'beta', 'gamma'])
    // 新数组：调用方改返回值不会污染契约缓存
    expect(out).not.toBe(DEFS)
  })

  it('空数组 = 显式关掉全部 → 一个都不给', () => {
    expect(filterAllowedToolDefs(DEFS, [])).toEqual([])
  })

  it('按名单过滤，顺序仍以契约为准（白名单不参与排序）', () => {
    expect(names(filterAllowedToolDefs(DEFS, ['gamma', 'alpha']))).toEqual([
      'alpha',
      'gamma',
    ])
  })

  it('名单里的未知工具名直接忽略', () => {
    expect(names(filterAllowedToolDefs(DEFS, ['beta', 'ghost_tool']))).toEqual(['beta'])
  })
})
