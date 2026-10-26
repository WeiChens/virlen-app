// @vitest-environment node
/**
 * 右侧面板标签页模型的纯函数口径。
 *
 * 三条被钉住的：
 * 1. **同一路径只开一个标签**：再点一次是「激活已有那个」，标签列表原样返回
 *    （否则两个标签各持一份草稿，保存起来互相踩）；
 * 2. **关掉激活的标签**：右邻居上来，没有右邻居取左邻居，全关光就是 null；
 * 3. **标题 / 目录**：Windows 反斜杠路径与正斜杠同口径。
 *
 * 另加一条批量口径（标签右键菜单）：`closeTabs` 必须与逐个 `closeTab` 收敛出同一个结果 ——
 * 「关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭」都会走它。
 * 最后一组是重排（拖标签换顺序）：`moveTab` 的下标就是最终下标，与容器的落点算法同口径。
 *
 * 预览位 / 常驻（`pinned`）单独一组：用户打开的是预览位（斜体、会被下一个文件顶掉），
 * present 交付与「再点一次」是常驻；升级之后永不退回。
 */
import { expect, it } from 'vitest'
import {
  browserTab,
  browserTabId,
  closeTab,
  closeTabs,
  fileTab,
  fileTabId,
  isPreviewTab,
  moveTab,
  openBrowserTab,
  openFileTab,
  openPageTab,
  openServiceTab,
  openTerminalTab,
  pageTab,
  pinTab,
  replacePageTab,
  replaceTabWith,
  serviceTabId,
  tabDir,
  tabLabel,
  terminalTab,
  terminalTabId,
  updateBrowserTab,
  updateBrowserTitle,
  FILES_TAB_ID,
  GUIDE_TAB_ID,
  type SidePanelTab,
} from '@/ui/pages/chat/components/side-panel/tabs'

/** 文件标签的路径（服务标签不该出现在这些断言里，出现就把 id 顶上来） */
const filePathOf = (tab: SidePanelTab): string =>
  tab.kind === 'file' ? tab.path : tab.id

it('id 由路径决定：同一个文件只有一种身份', () => {
  expect(fileTabId('E:/repo/a.ts')).toBe('file:E:/repo/a.ts')
  expect(fileTab('E:/repo/a.ts').id).toBe(fileTabId('E:/repo/a.ts'))
})

it('打开新文件：追加到末尾并激活它', () => {
  const first = openFileTab([], 'E:/repo/a.ts')
  expect(first.added).toBe(true)
  expect(first.tabs.map(filePathOf)).toEqual(['E:/repo/a.ts'])
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

/**
 * present 的交付物默认给人看：标签记住「打开时的视图」，同一个文件再交付一次靠 `viewSeq`
 * 把视图请回去（不重建标签 —— 草稿、Monaco 撤销栈都还在里面）。
 */
it('present 打开的标签记住「预览」，重复交付只更新视图提示', () => {
  const opened = openFileTab([], 'E:/repo/a.html', { view: 'preview', viewSeq: 1, pinned: true })
  expect(opened.added).toBe(true)
  const tab = opened.tabs[0]
  expect(tab.kind === 'file' && tab.view).toBe('preview')
  expect(tab.kind === 'file' && tab.viewSeq).toBe(1)

  // 普通打开（无 view）不碰这个提示：用户手动切到编辑后不该被它改回去
  const plain = openFileTab(opened.tabs, 'E:/repo/a.html')
  expect(plain.tabs).toBe(opened.tabs)

  // 同一个文件再 present 一次：seq 变了 → 换一份标签（面板据此迁回预览）
  const again = openFileTab(opened.tabs, 'E:/repo/a.html', { view: 'preview', viewSeq: 2, pinned: true })
  expect(again.tabs).not.toBe(opened.tabs)
  expect(again.tabs.length).toBe(1)
  const updated = again.tabs[0]
  expect(updated.kind === 'file' && updated.viewSeq).toBe(2)

  // 值完全没变：返回原引用（宿主不必重渲染）
  const same = openFileTab(again.tabs, 'E:/repo/a.html', { view: 'preview', viewSeq: 2, pinned: true })
  expect(same.tabs).toBe(again.tabs)
})

/**
 * 预览位（临时标签）与常驻：用户点开的是「先看一眼」，下一个打开的文件顶掉它；
 * 常驻（present 交付 / 留住了的）谁都不顶。四条升级路径见 `tabs.ts` 头注释第 6 条。
 */
it('预览位：打开另一个文件顶掉激活着的预览位（标签数不变，位置不变）', () => {
  const first = openFileTab([], 'E:/repo/a.ts')
  const openedTab = first.tabs[0]
  expect(isPreviewTab(openedTab)).toBe(true)

  const second = openFileTab(first.tabs, 'E:/repo/b.ts', { activeId: first.activeId })
  expect(second.added).toBe(true)
  // 顶掉那一格：不是新增，也没有「两个标签各持一份草稿」
  expect(second.tabs.length).toBe(1)
  expect(second.tabs.map(filePathOf)).toEqual(['E:/repo/b.ts'])
  expect(second.activeId).toBe(fileTabId('E:/repo/b.ts'))

  // 占位顺序也保住了：中间那一格被顶掉，左右还是原来的邻居
  const three = [
    fileTab('E:/repo/a', undefined, undefined, true),
    // 中间这个是预览位（用户最后打开的那个）
    fileTab('E:/repo/b'),
    fileTab('E:/repo/c', undefined, undefined, true),
  ]
  const preview = openFileTab(three, 'E:/repo/p.ts', { activeId: fileTabId('E:/repo/b') })
  expect(preview.tabs.map(filePathOf).map((path) => path.split('/').pop())).toEqual([
    'a',
    'p.ts',
    'c',
  ])
})

it('常驻：present 交付 / 再点一次激活着的它 / pinTab 都会留下来', () => {
  // present 从不顶掉别人：直接追加
  const delivered = openFileTab([], 'E:/repo/out.html', { pinned: true })
  expect(isPreviewTab(delivered.tabs[0])).toBe(false)
  const more = openFileTab(delivered.tabs, 'E:/repo/b.ts', { activeId: delivered.activeId })
  expect(more.tabs.length).toBe(2)

  // 再次打开**已经激活的**它 = 用户点第二遍：「这个我要留着」
  const again = openFileTab(more.tabs, 'E:/repo/b.ts', { activeId: fileTabId('E:/repo/b.ts') })
  expect(isPreviewTab(again.tabs[1])).toBe(false)

  // 不是激活的那个再打开：只切过去，还是预览位（下次会被顶掉）
  const other = openFileTab(more.tabs, 'E:/repo/b.ts', { activeId: delivered.activeId })
  expect(other.tabs).toBe(more.tabs)

  // 双击标签那条路：`pinTab` 升级；已经常驻 / 不是文件标签 / 已经关掉 → 原引用
  const pinned = pinTab(more.tabs, fileTabId('E:/repo/b.ts'))
  expect(isPreviewTab(pinned[1])).toBe(false)
  expect(pinTab(pinned, fileTabId('E:/repo/b.ts'))).toBe(pinned)
  expect(pinTab(more.tabs, 'nope')).toBe(more.tabs)
})

it('关掉非激活的标签：激活态不动', () => {
  const tabs = [fileTab('E:/repo/a.ts'), fileTab('E:/repo/b.ts')]
  const result = closeTab(tabs, fileTabId('E:/repo/a.ts'), fileTabId('E:/repo/b.ts'))

  expect(result.tabs.map(filePathOf)).toEqual(['E:/repo/b.ts'])
  expect(result.activeId).toBe(fileTabId('E:/repo/b.ts'))
})

it('关掉激活的标签：右邻居上来', () => {
  const tabs = [fileTab('a'), fileTab('b'), fileTab('c')]
  const result = closeTab(tabs, fileTabId('b'), fileTabId('b'))

  expect(result.tabs.map(filePathOf)).toEqual(['a', 'c'])
  expect(result.activeId).toBe(fileTabId('c'))
})

it('关掉最后一个标签（无右邻居）：退到左邻居', () => {
  const tabs = [fileTab('a'), fileTab('b')]
  const result = closeTab(tabs, fileTabId('b'), fileTabId('b'))

  expect(result.tabs.map(filePathOf)).toEqual(['a'])
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

it('批量关闭：激活的标签没被包含时激活态不动', () => {
  const tabs = [fileTab('a'), fileTab('b'), fileTab('c')]
  const result = closeTabs(tabs, [fileTabId('b'), fileTabId('c')], fileTabId('a'))

  expect(result.tabs.map(filePathOf)).toEqual(['a'])
  expect(result.activeId).toBe(fileTabId('a'))
})

/** 「关闭其他」：右邻居一路顶上来，唯一剩下的那个自然就是激活的 */
it('批量关闭：原来激活的被关掉时，退回最后一个存活标签', () => {
  const tabs = [fileTab('a'), fileTab('b'), fileTab('c')]
  const result = closeTabs(tabs, [fileTabId('a'), fileTabId('b')], fileTabId('a'))

  expect(result.tabs.map(filePathOf)).toEqual(['c'])
  expect(result.activeId).toBe(fileTabId('c'))
})

it('关闭右侧：只关目标右边的，左边的与目标本身不动', () => {
  const tabs = [fileTab('a'), fileTab('b'), fileTab('c')]
  const result = closeTabs(tabs, [fileTabId('c')], fileTabId('a'))

  expect(result.tabs.map(filePathOf)).toEqual(['a', 'b'])
  expect(result.activeId).toBe(fileTabId('a'))
})

it('批量关光：激活态变 null（宿主据此卸掉整块面板）', () => {
  const tabs = [fileTab('a'), fileTab('b')]
  const result = closeTabs(tabs, [fileTabId('a'), fileTabId('b')], fileTabId('b'))

  expect(result.tabs).toEqual([])
  expect(result.activeId).toBeNull()
})

it('批量里全是不存在的 id：返回原引用（不触发无意义的重渲染）', () => {
  const tabs = [fileTab('a')]
  const result = closeTabs(tabs, ['file:nope'], fileTabId('a'))

  expect(result.tabs).toBe(tabs)
  expect(result.activeId).toBe(fileTabId('a'))
})

/**
 * 剩一个但 `activeId` 是 null 的兵场：逐个 `closeTab` 只会在「关掉激活那个」时改激活态，
 * 宿主初始 `activeId=null` 时批量关完就会留下「有标签但没激活」——下次关标签失去邻居基准。
 */
it('批量关完还有标签却没有激活态：退回第一个', () => {
  const tabs = [fileTab('a'), fileTab('b')]
  const result = closeTabs(tabs, [fileTabId('a')], null)

  expect(result.tabs.map(filePathOf)).toEqual(['b'])
  expect(result.activeId).toBe(fileTabId('b'))
})

it('标题与目录：兼容 Windows 反斜杠', () => {
  expect(tabLabel('E:\\repo\\src\\a.ts')).toBe('a.ts')
  expect(tabLabel('E:/repo/src/a.ts')).toBe('a.ts')
  expect(tabDir('E:\\repo\\src\\a.ts')).toBe('E:/repo/src')
  expect(tabDir('a.ts')).toBe('')
})

/** 重排（拖标签）：下标是「插入到最终位置」，与拖拽落点算法同口径 */
it('重排：往右挪 / 往左挪都按最终下标落位', () => {
  const tabs = [fileTab('a'), fileTab('b'), fileTab('c')]
  expect(moveTab(tabs, fileTabId('a'), 2).map(filePathOf)).toEqual(['b', 'c', 'a'])
  expect(moveTab(tabs, fileTabId('c'), 0).map(filePathOf)).toEqual(['c', 'a', 'b'])
  expect(moveTab(tabs, fileTabId('a'), 1).map(filePathOf)).toEqual(['b', 'a', 'c'])
})

it('重排：没动位置 / 不存在的 id 都返回原引用（不触发重渲染），越界夹进范围', () => {
  const tabs = [fileTab('a'), fileTab('b')]
  expect(moveTab(tabs, fileTabId('a'), 0)).toBe(tabs)
  expect(moveTab(tabs, fileTabId('nope'), 1)).toBe(tabs)
  expect(moveTab(tabs, fileTabId('a'), 99).map(filePathOf)).toEqual(['b', 'a'])
  expect(moveTab(tabs, fileTabId('b'), -3).map(filePathOf)).toEqual(['b', 'a'])
})

/**
 * 服务终端标签：身份 = 会话 + 服务。同一个服务再点一次只能「切过去」——
 * 两份 xterm 抢同一个伪控制台，键击与尺寸都会互相打断。
 */
it('服务标签：id 带会话（同一服务 id 在不同会话下是两个身份）', () => {
  expect(serviceTabId('s1', 'svc_1')).toBe('service:s1:svc_1')
  const first = openServiceTab([], { sessionId: 's1', serviceId: 'svc_1', name: 'dev' })
  const other = openServiceTab(first.tabs, {
    sessionId: 's2',
    serviceId: 'svc_1',
    name: 'dev',
  })
  expect(first.added).toBe(true)
  expect(first.activeId).toBe('service:s1:svc_1')
  expect(other.tabs.length).toBe(2)
  expect(other.activeId).toBe('service:s2:svc_1')
})

it('服务标签：已开着就只切过去（列表引用不变），并与文件标签共存', () => {
  const opened = openServiceTab([fileTab('a')], {
    sessionId: 's1',
    serviceId: 'svc_1',
    name: 'dev',
  })
  expect(opened.tabs.length).toBe(2)
  expect(opened.tabs[1]).toMatchObject({
    kind: 'service',
    sessionId: 's1',
    serviceId: 'svc_1',
    name: 'dev',
  })

  const again = openServiceTab(opened.tabs, {
    sessionId: 's1',
    serviceId: 'svc_1',
    name: 'dev',
  })
  expect(again.added).toBe(false)
  expect(again.tabs).toBe(opened.tabs)
  expect(again.activeId).toBe('service:s1:svc_1')
})

/**
 * 「页面」标签（开始页 `guide` / 工作区文件树 `files`）是**单例**：
 * 它们不按路径去重，而是按 kind —— `+` 连点两次只有一个开始页。
 */
it('页面标签：按 kind 单例，已开着就只切过去', () => {
  const guide = openPageTab([], 'guide')
  expect(guide.added).toBe(true)
  expect(guide.activeId).toBe(GUIDE_TAB_ID)
  expect(guide.tabs[0]).toMatchObject({ kind: 'guide', id: GUIDE_TAB_ID })

  const again = openPageTab(guide.tabs, 'guide')
  expect(again.added).toBe(false)
  expect(again.tabs).toBe(guide.tabs)
  expect(again.activeId).toBe(GUIDE_TAB_ID)

  const files = openPageTab(guide.tabs, 'files')
  expect(files.tabs.map((tab) => tab.kind)).toEqual(['guide', 'files'])
  expect(files.activeId).toBe(FILES_TAB_ID)
})

/**
 * 开始页是「门厅」不是常驻页面：点胶囊后它必须消失，且目标页**接管它那一格**
 * （参考实现的 `replaceTab: true`；标签栏里多留一个「开始」只会让人误以为可以回到首页）。
 */
it('开始页点入口：目标页接管开始页的位置，开始页消失', () => {
  const tabs = [fileTab('a'), pageTab('guide'), fileTab('b')]
  const next = replacePageTab(tabs, 'files', GUIDE_TAB_ID)

  expect(next.added).toBe(true)
  expect(next.tabs.map((tab) => tab.kind)).toEqual(['file', 'files', 'file'])
  expect(next.activeId).toBe(FILES_TAB_ID)
})

it('开始页点入口（目标页已开着）：只激活目标页，顺手关掉开始页', () => {
  const tabs = [pageTab('files'), pageTab('guide')]
  const next = replacePageTab(tabs, 'files', GUIDE_TAB_ID)

  expect(next.added).toBe(false)
  expect(next.tabs.map((tab) => tab.kind)).toEqual(['files'])
  expect(next.activeId).toBe(FILES_TAB_ID)
})

it('开始页已不在（菜单开着时被关掉）：退化成普通打开，别把标签弄丢', () => {
  const next = replacePageTab([fileTab('a')], 'files', GUIDE_TAB_ID)
  expect(next.tabs.map((tab) => tab.kind)).toEqual(['file', 'files'])
  expect(next.activeId).toBe(FILES_TAB_ID)
})

/** 造一个终端标签入参（`pid` 只是诊断字段，不同就代表「另一个进程」） */
const term = (termId: string, pid = 101) => ({
  termId,
  sessionId: 's1',
  shell: 'powershell',
  cwd: 'E:/repo',
  pid,
})

/**
 * 用户终端：id 由终端 id 决定（同一个终端不能开两份 —— 两个 xterm 抢一个伪控制台），
 * 重复打开只切过去。
 */
it('终端标签：id 即身份，重复打开只切过去', () => {
  expect(terminalTabId('term_1')).toBe('terminal:term_1')
  expect(terminalTab(term('term_1')).id).toBe('terminal:term_1')

  const opened = openTerminalTab([], term('term_1'))
  expect(opened.added).toBe(true)
  expect(opened.activeId).toBe('terminal:term_1')

  const again = openTerminalTab(opened.tabs, term('term_1', 2))
  expect(again.added).toBe(false)
  expect(again.tabs).toBe(opened.tabs)
  expect(again.activeId).toBe('terminal:term_1')
})

/**
 * 「新建终端」是异步的（先起进程才拿到 id），所以开始页不能用 `replacePageTab`：
 * `replaceTabWith` 直接把新标签放进开始页那一格，看不到「开始页 ⭢ 新标签」的跳位。
 */
it('replaceTabWith：新标签接管来源页那一格，来源页消失', () => {
  const tabs = [fileTab('a'), pageTab('guide'), fileTab('b')]
  const next = replaceTabWith(tabs, terminalTab(term('term_9')), GUIDE_TAB_ID)

  expect(next.tabs.map((tab) => tab.id)).toEqual([
    'file:a',
    'terminal:term_9',
    'file:b',
  ])
  expect(next.activeId).toBe('terminal:term_9')
})

it('replaceTabWith：来源页已经不在时追加到末尾，不丢标签', () => {
  const next = replaceTabWith([fileTab('a')], terminalTab(term('term_9')), GUIDE_TAB_ID)
  expect(next.tabs.map((tab) => tab.id)).toEqual(['file:a', 'terminal:term_9'])
  expect(next.activeId).toBe('terminal:term_9')
})

/**
 * 网页标签：与文件 / 终端相反，**同一个网址可以开好几个** —— 对照两个分支、
 * 同一个文档的不同锚点都是它的正经用法。身份是宿主自增的 `seq`，不是网址。
 */
it('网页标签：id 由序号决定（同一个网址也能开两份），每次都追加并激活', () => {
  expect(browserTabId(3)).toBe('browser:3')
  expect(browserTab({ seq: 3, url: 'https://a.com/' }).id).toBe('browser:3')

  const first = openBrowserTab([], { seq: 1, url: 'https://a.com/' })
  expect(first.added).toBe(true)
  expect(first.activeId).toBe('browser:1')

  const second = openBrowserTab(first.tabs, { seq: 2, url: 'https://a.com/' })
  expect(second.tabs.map((tab) => tab.id)).toEqual(['browser:1', 'browser:2'])
  expect(second.activeId).toBe('browser:2')
})

it('网页标签：地址写回（标题跟着换），值没变 / 标签不在 / 不是网页都返回原引用', () => {
  const tabs = [
    fileTab('a'),
    browserTab({ seq: 1, url: 'https://a.com/' }),
    browserTab({ seq: 2, url: '' }),
  ]
  const moved = updateBrowserTab(tabs, 'browser:1', 'https://b.com/x')
  expect(moved).not.toBe(tabs)
  expect(moved[1]).toMatchObject({ kind: 'browser', url: 'https://b.com/x', seq: 1 })
  // 其他标签原封不动
  expect(moved[0]).toBe(tabs[0])
  expect(moved[2]).toBe(tabs[2])

  expect(updateBrowserTab(moved, 'browser:1', 'https://b.com/x')).toBe(moved)
  expect(updateBrowserTab(moved, 'browser:9', 'https://c.com/')).toBe(moved)
  expect(updateBrowserTab(moved, 'file:a', 'https://c.com/')).toBe(moved)
})

it('网页标签：空白页的地址是空串（面板据此渲染输入引导，而不是加载 about:blank）', () => {
  const tab = browserTab({ seq: 5 })
  expect(tab.kind === 'browser' && tab.url).toBe('')
})

it('网页标签：标题写回只改文字（不动地址），没变 / 空标题 / 标签不在都返回原引用', () => {
  const tabs = [
    fileTab('a'),
    browserTab({ seq: 1, url: 'https://a.com/' }),
    browserTab({ seq: 2, url: 'https://b.com/' }),
  ]
  const named = updateBrowserTitle(tabs, 'browser:1', 'A 站首页')
  expect(named).not.toBe(tabs)
  expect(named[1]).toMatchObject({
    kind: 'browser',
    url: 'https://a.com/',
    title: 'A 站首页',
  })
  // 其他标签原封不动
  expect(named[0]).toBe(tabs[0])
  expect(named[2]).toBe(tabs[2])

  expect(updateBrowserTitle(named, 'browser:1', 'A 站首页')).toBe(named)
  // 空标题不是「标题变成空」：宁可留着上一次的，也不要给标签一个空文字
  expect(updateBrowserTitle(named, 'browser:1', '  ')).toBe(named)
  expect(updateBrowserTitle(named, 'browser:9', 'x')).toBe(named)
  expect(updateBrowserTitle(named, 'file:a', 'x')).toBe(named)
})
