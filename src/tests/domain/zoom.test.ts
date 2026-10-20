/**
 * 界面缩放的口径（纯函数）：设置页滑杆、hook、埋点读的都是这一份。
 *
 * 守三件事：
 *  ① 脏数据（NaN / 空串 / 0 / 负数）回落 100% —— 绝不把 NaN 递给 webview 的 setZoom；
 *  ② 越界夹紧到 [ZOOM_MIN, ZOOM_MAX]；
 *  ③ 保留两位小数：step 累加出来的 `1.0500000000000003` 会被规整掉。
 */
import { expect, it } from 'vitest'
import {
  DEFAULT_ZOOM,
  ZOOM_KEY_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
  applyZoomCommand,
  normalizeZoom,
  zoomCommandOf,
  zoomPercent,
} from '@/domain/zoom'

it('默认 100% 落在合法区间里', () => {
  expect(DEFAULT_ZOOM).toBe(1)
  expect(ZOOM_MIN).toBeLessThan(DEFAULT_ZOOM)
  expect(ZOOM_MAX).toBeGreaterThan(DEFAULT_ZOOM)
})

it('脏数据一律回落默认值（NaN / 空串 / 0 / 负数）', () => {
  for (const dirty of [undefined, null, NaN, Infinity, 'abc', '', 0, -1, -0.5]) {
    expect(normalizeZoom(dirty)).toBe(DEFAULT_ZOOM)
  }
})

it('数字字符串照收（滑杆给的永远是字符串）', () => {
  expect(normalizeZoom('1.25')).toBe(1.25)
  expect(normalizeZoom('0.9')).toBe(0.9)
})

it('越界夹紧到上下限', () => {
  expect(normalizeZoom(0.1)).toBe(ZOOM_MIN)
  expect(normalizeZoom(5)).toBe(ZOOM_MAX)
})

it('保留两位小数：step 累加的尾巴不会漏进设置', () => {
  expect(normalizeZoom(1.0500000000000003)).toBe(1.05)
  expect(normalizeZoom(1.234567)).toBe(1.23)
})

it('百分比展示值', () => {
  expect(zoomPercent(1)).toBe(100)
  expect(zoomPercent(1.25)).toBe(125)
  expect(zoomPercent('0.9')).toBe(90)
  // 脏值走同一条归一化：展示与真正应用的倍率不会各说一套
  expect(zoomPercent(NaN)).toBe(100)
})

it('快捷键：一步 10%，且碰不到上下限之外', () => {
  expect(applyZoomCommand(1, 'in')).toBe(1 + ZOOM_KEY_STEP)
  expect(applyZoomCommand(1, 'out')).toBe(1 - ZOOM_KEY_STEP)
  // 到顶 / 到底后再按不变（夹紧），不会跑到 210% 或无下限地缩小
  expect(applyZoomCommand(ZOOM_MAX, 'in')).toBe(ZOOM_MAX)
  expect(applyZoomCommand(1.95, 'in')).toBe(ZOOM_MAX)
  expect(applyZoomCommand(ZOOM_MIN, 'out')).toBe(ZOOM_MIN)
  expect(applyZoomCommand(0.55, 'out')).toBe(ZOOM_MIN)
  // 脏数据先归一化再步进
  expect(applyZoomCommand(NaN, 'in')).toBe(1.1)
})

it('快捷键：复位不管当前是多少都回 100%', () => {
  for (const current of [0.5, 1.37, 2, 'bad']) {
    expect(applyZoomCommand(current, 'reset')).toBe(DEFAULT_ZOOM)
  }
})

it('认键：Ctrl / Cmd + = + - 0（含小键盘与副字符）', () => {
  // 放大：`+`、`=`（不必按 Shift）、小键盘 +
  expect(zoomCommandOf({ key: '=', ctrlKey: true })).toBe('in')
  expect(zoomCommandOf({ key: '+', ctrlKey: true })).toBe('in')
  expect(zoomCommandOf({ key: 'Add', code: 'NumpadAdd', ctrlKey: true })).toBe('in')
  // 缩小：- 、_（Shift+-）、小键盘 -
  expect(zoomCommandOf({ key: '-', ctrlKey: true })).toBe('out')
  expect(zoomCommandOf({ key: '_', ctrlKey: true })).toBe('out')
  expect(zoomCommandOf({ key: 'Subtract', code: 'NumpadSubtract', ctrlKey: true })).toBe('out')
  // 复位：主键盘 0 / 小键盘 0
  expect(zoomCommandOf({ key: '0', ctrlKey: true })).toBe('reset')
  expect(zoomCommandOf({ key: '0', code: 'Numpad0', ctrlKey: true })).toBe('reset')
  // macOS 用 Cmd
  expect(zoomCommandOf({ key: '=', metaKey: true })).toBe('in')
  // 非拉丁键盘：key 拿不准时靠物理键位
  expect(zoomCommandOf({ key: 'Dead', code: 'Equal', ctrlKey: true })).toBe('in')
})

it('不抢：无修饰键 / Alt 组合 / 其它键都不算缩放', () => {
  expect(zoomCommandOf({ key: '=', ctrlKey: false })).toBeNull()
  expect(zoomCommandOf({ key: '=', ctrlKey: true, altKey: true })).toBeNull()
  expect(zoomCommandOf({ key: 'p', code: 'KeyP', ctrlKey: true })).toBeNull()
  // 不传 key / code 也不抛
  expect(zoomCommandOf({ ctrlKey: true })).toBeNull()
})
