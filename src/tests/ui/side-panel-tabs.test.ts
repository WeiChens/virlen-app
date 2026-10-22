/**
 * 右侧面板标签页模型的纯函数口径。
 *
 * 三条被钉住的：
 * 1. **同一路径只开一个标签**：再点一次是「激活已有那个」，标签列表原样返回
 *    （否则两个标签各持一份草稿，保存起来互相踩）；
 * 2. **关掉激活的标签**：右邻居上来，没有右邻居取左邻居，全关光就是 null；
 * 3. **标题 / 目录**：Windows 反斜杠路径与正斜杠同口径。
 */
import { expect, it } from 'vitest'
import {
  closeTab,
  fileTab,
  fileTabId,
  openFileTab,
  tabDir,
  tabLabel,
} from '@/ui/pages/chat/components/side-panel/tabs'

it('id 由路径决定：同一个文件只有一种身份', () => {
  expect(fileTabId('E:/repo/a.ts')).toBe('file:E:/repo/a.ts')
  expect(fileTab('E:/repo/a.ts').id).toBe(fileTabId('E:/repo/a.ts'))
})

it('打开新文件：追加到末尾并激活它', () => {
  const first = openFileTab([], 'E:/repo/a.ts')
  expect(first.added).toBe(true)
  expect(first.tabs.map((tab) => tab.path)).toEqual(['E:/repo/a.ts'])
  expect(first.activeId).toBe(fileTabId('E:/repo/a.ts'))

  const second = openFileTab(first.tabs, 'E:/repo/b.ts')
  expect(second.tabs.length).toBe(2)
  expect(second.activeId).toBe(fileTabId('E:/repo/b.ts'))
})

/** 旧实现是单面板：换文件必须确认丢弃草稿。多标签之后这条路径不该再丢任何东西 */
it('打开已打开的文件：只切过去，列表引用都不变（草稿一个字都不动）', () => {
  const opened = openFileTab([], 'E:/repo/a.ts')
  const again = openFileTab(opened.tabs, 'E:/repo/a.ts')

  expect(again.added).toBe(false)
  expect(again.tabs).toBe(opened.tabs)
  expect(again.activeId).toBe(fileTabId('E:/repo/a.ts'))
})

it('关掉非激活的标签：激活态不动', () => {
  const tabs = [fileTab('E:/repo/a.ts'), fileTab('E:/repo/b.ts')]
  const result = closeTab(tabs, fileTabId('E:/repo/a.ts'), fileTabId('E:/repo/b.ts'))

  expect(result.tabs.map((tab) => tab.path)).toEqual(['E:/repo/b.ts'])
  expect(result.activeId).toBe(fileTabId('E:/repo/b.ts'))
})

it('关掉激活的标签：右邻居上来', () => {
  const tabs = [fileTab('a'), fileTab('b'), fileTab('c')]
  const result = closeTab(tabs, fileTabId('b'), fileTabId('b'))

  expect(result.tabs.map((tab) => tab.path)).toEqual(['a', 'c'])
  expect(result.activeId).toBe(fileTabId('c'))
})

it('关掉最后一个标签（无右邻居）：退到左邻居', () => {
  const tabs = [fileTab('a'), fileTab('b')]
  const result = closeTab(tabs, fileTabId('b'), fileTabId('b'))

  expect(result.tabs.map((tab) => tab.path)).toEqual(['a'])
  expect(result.activeId).toBe(fileTabId('a'))
})

it('关光所有标签：激活态变 null（宿主据此卸掉整块面板）', () => {
  const result = closeTab([fileTab('a')], fileTabId('a'), fileTabId('a'))
  expect(result.tabs).toEqual([])
  expect(result.activeId).toBeNull()
})

it('关一个不存在的标签：原样返回，别把激活态弄丢', () => {
  const tabs = [fileTab('a')]
  const result = closeTab(tabs, fileTabId('nope'), fileTabId('a'))
  expect(result.tabs).toBe(tabs)
  expect(result.activeId).toBe(fileTabId('a'))
})

it('标题与目录：兼容 Windows 反斜杠', () => {
  expect(tabLabel('E:\\repo\\src\\a.ts')).toBe('a.ts')
  expect(tabLabel('E:/repo/src/a.ts')).toBe('a.ts')
  expect(tabDir('E:\\repo\\src\\a.ts')).toBe('E:/repo/src')
  expect(tabDir('a.ts')).toBe('')
})
