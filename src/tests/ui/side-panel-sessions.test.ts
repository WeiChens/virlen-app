// @vitest-environment node
/**
 * 右侧面板的**会话分桶**（`side-panel/sessions.ts`）—— 「收起 / 切会话不清状态」靠的就是它。
 *
 * 六条被钉住的：
 * 1. **桶 key = 会话 id**，新对话页（`null`）单独一桶；
 * 2. **标签 id 带会话前缀**：同一个文件在两个会话里各有一份（id 不同、草稿不互相踩），
 *    加前缀是幂等的（宿主会拿着已经带前缀的 id 再走一遍）；
 * 3. **加标签自动展开**，关标签 / 改地址 / 改标题 / 切标签**不碰** `open`（否则网页在后台
 *    报个标题就能把用户亲手收起的面板弹回来）；
 * 4. **别的会话的标签是「parked」**：内容照旧交给容器挂着，只是不在当前这一桶里；
 * 5. **关掉当前会话的标签不影响别人**；
 * 6. **会话被删就丢掉它的桶**（并把标签交回宿主杀终端），但新对话页那一桶与当前桶永远保留 ——
 *    会话列表懒加载时可能是空的，那一瞬清桶等于杀用户草稿。
 */
import { describe, expect, it } from 'vitest'

import {
  NEW_PANEL_KEY,
  bucketOf,
  clearBucketTabs,
  guideTabIdOf,
  isBucketVisible,
  panelKeyOf,
  parkedTabsOf,
  scopeTabId,
  scopeTabs,
  sessionIdOfTab,
  tabScopeOf,
  withBucketOpen,
  withBucketTabs,
  withoutSessions,
  type PanelBuckets,
} from '@/ui/pages/chat/components/side-panel/sessions'
import {
  fileTab,
  openFileTab,
  openPageTab,
  openServiceTab,
  terminalTab,
  type SidePanelTab,
} from '@/ui/pages/chat/components/side-panel/tabs'

const S1 = 'sess-1'
const S2 = 'sess-2'

/** 按宿主的口径往某个会话的桶里开文件（含加前缀） */
function openFile(
  buckets: PanelBuckets,
  key: string,
  path: string,
): PanelBuckets {
  const next = openFileTab(bucketOf(buckets, key).tabs, path)
  return withBucketTabs(buckets, key, next)
}

describe('会话分桶 · key 与前缀', () => {
  it('新对话页单独一桶；真会话用 id', () => {
    expect(panelKeyOf(null)).toBe(NEW_PANEL_KEY)
    expect(panelKeyOf('')).toBe(NEW_PANEL_KEY)
    expect(panelKeyOf(S1)).toBe(S1)
  })

  it('标签 id 加会话前缀，且幂等（宿主会重复走一遍）', () => {
    expect(scopeTabId(S1, 'file:a.ts')).toBe(`${S1}\u0000file:a.ts`)
    expect(scopeTabId(S1, scopeTabId(S1, 'file:a.ts'))).toBe(`${S1}\u0000file:a.ts`)

    // 整批加前缀：已经带前缀的原样返回，没变化时连数组引用都不换
    const tabs = [fileTab('a.ts')]
    const scoped = scopeTabs(S1, tabs)
    expect(scoped[0].id).toBe(`${S1}\u0000file:a.ts`)
    expect(scopeTabs(S1, scoped)).toBe(scoped)
  })

  it('从 id 反解归属会话（新对话页不算会话 id）', () => {
    const own = scopeTabs(S1, [fileTab('a.ts')])[0]
    expect(tabScopeOf(own)).toBe(S1)
    expect(sessionIdOfTab(own)).toBe(S1)

    const scratch = scopeTabs(NEW_PANEL_KEY, [fileTab('a.ts')])[0]
    expect(sessionIdOfTab(scratch)).toBeUndefined()

    // 手搓的标签（没前缀）：容器退回宿主传的兜底 sessionId
    expect(tabScopeOf(fileTab('a.ts'))).toBeNull()
    expect(sessionIdOfTab(fileTab('a.ts'))).toBeUndefined()
  })
})

describe('会话分桶 · 落状态', () => {
  it('开标签就展开；关掉以后桶还是那一桶（标签不一定为空）', () => {
    let buckets: PanelBuckets = {}
    expect(isBucketVisible(bucketOf(buckets, S1))).toBe(false)

    buckets = openFile(buckets, S1, 'E:/repo/a.ts')
    expect(bucketOf(buckets, S1).open).toBe(true)
    expect(isBucketVisible(bucketOf(buckets, S1))).toBe(true)
    expect(bucketOf(buckets, S1).tabs.length).toBe(1)
  })

  it('同一个文件在两个会话里各一份（id 不同、互不去重）', () => {
    let buckets: PanelBuckets = {}
    buckets = openFile(buckets, S1, 'E:/repo/a.ts')
    buckets = openFile(buckets, S2, 'E:/repo/a.ts')

    const one = bucketOf(buckets, S1).tabs
    const two = bucketOf(buckets, S2).tabs
    expect(one.length).toBe(1)
    expect(two.length).toBe(1)
    expect(one[0].id).not.toBe(two[0].id)
  })

  it('同一个会话里再开同一个文件：只切过去，不多一份', () => {
    let buckets: PanelBuckets = openFile({}, S1, 'E:/repo/a.ts')
    buckets = openFile(buckets, S1, 'E:/repo/a.ts')
    expect(bucketOf(buckets, S1).tabs.length).toBe(1)
  })

  it('改地址 / 改标题 / 切标签不碰 open（收起的面板不能被后台事件弹回来）', () => {
    let buckets: PanelBuckets = openFile({}, S1, 'E:/repo/a.ts')
    buckets = withBucketOpen(buckets, S1, false)
    const tabs = bucketOf(buckets, S1).tabs

    // 标签数量没变（切激活态 / 网页改地址都是这一类）
    buckets = withBucketTabs(buckets, S1, { tabs, activeId: tabs[0].id })
    expect(bucketOf(buckets, S1).open).toBe(false)

    // 关掉标签也不展开
    buckets = withBucketTabs(buckets, S1, { tabs: [], activeId: null })
    expect(bucketOf(buckets, S1).open).toBe(false)
  })

  it('展开 / 收起是每个会话自己的', () => {
    let buckets: PanelBuckets = openFile({}, S1, 'E:/repo/a.ts')
    buckets = openFile(buckets, S2, 'E:/repo/b.ts')
    buckets = withBucketOpen(buckets, S1, false)
    expect(bucketOf(buckets, S1).open).toBe(false)
    expect(bucketOf(buckets, S2).open).toBe(true)

    // 值没变就返回原引用（宿主据此不重渲染）
    expect(withBucketOpen(buckets, S1, false)).toBe(buckets)
  })

  it('开始页 id 也带前缀（两个会话各有一个「开始页」）', () => {
    expect(guideTabIdOf(S1)).not.toBe(guideTabIdOf(S2))
    // 宿主的路径：标签模型不管前缀，落桶时统一加
    const buckets = withBucketTabs({}, S1, openPageTab([], 'guide'))
    expect(bucketOf(buckets, S1).activeId).toBe(guideTabIdOf(S1))
    expect(bucketOf(buckets, S1).tabs[0].id).toBe(guideTabIdOf(S1))
  })
})

describe('会话分桶 · 其它会话挂着的那份', () => {
  it('parked = 别的会话的全部标签（内容不卸载，切回来原样）', () => {
    let buckets: PanelBuckets = openFile({}, S1, 'E:/repo/a.ts')
    buckets = openFile(buckets, S2, 'E:/repo/b.ts')

    expect(parkedTabsOf(buckets, S1).map((tab) => tab.id)).toEqual([
      `${S2}\u0000file:E:/repo/b.ts`,
    ])
    expect(parkedTabsOf(buckets, S2).map((tab) => tab.id)).toEqual([
      `${S1}\u0000file:E:/repo/a.ts`,
    ])
    expect(parkedTabsOf(buckets, NEW_PANEL_KEY)).toHaveLength(2)
  })

  it('关掉当前会话的标签，别的会话一条不少', () => {
    let buckets: PanelBuckets = openFile({}, S1, 'E:/repo/a.ts')
    buckets = openFile(buckets, S2, 'E:/repo/b.ts')
    buckets = clearBucketTabs(buckets, S1)

    expect(bucketOf(buckets, S1).tabs).toHaveLength(0)
    expect(bucketOf(buckets, S2).tabs.map((tab) => tab.id)).toEqual([
      `${S2}\u0000file:E:/repo/b.ts`,
    ])
  })
})

describe('会话分桶 · 会话被删', () => {
  it('丢掉已删会话的桶，并把它的标签交回来（宿主据此杀终端）', () => {
    let buckets: PanelBuckets = openFile({}, S1, 'E:/repo/a.ts')
    buckets = openFile(buckets, S2, 'E:/repo/b.ts')
    const terminal = scopeTabs(S2, [
      terminalTab({
        termId: 'term_9',
        sessionId: S2,
        shell: 'cmd',
        cwd: 'E:/repo',
        pid: 1,
        index: 1,
      }),
    ])[0]
    const withTerminal: SidePanelTab[] = [...bucketOf(buckets, S1).tabs, terminal]
    buckets = withBucketTabs(buckets, S1, { tabs: withTerminal, activeId: null })

    // S1 被删了（当前在 S2）
    const result = withoutSessions(buckets, new Set([S2]), S2)
    expect(Object.keys(result.buckets)).toEqual([S2])
    expect(result.dropped.map((tab) => tab.kind).sort()).toEqual(['file', 'terminal'])
  })

  it('新对话页那一桶与当前这一桶永远保留；没有可丢的就返回原引用', () => {
    let buckets: PanelBuckets = openFile({}, NEW_PANEL_KEY, 'E:/repo/scratch.ts')
    buckets = openFile(buckets, S1, 'E:/repo/a.ts')

    const kept = withoutSessions(buckets, new Set<string>(), S1)
    expect(kept.buckets).toBe(buckets)
    expect(kept.dropped).toHaveLength(0)
  })
})

describe('会话分桶 · 与标签模型的配合', () => {
  it('带前缀的标签仍按内容去重（服务终端同一会话+服务只开一份）', () => {
    const key = S1
    const scoped = scopeTabs(key, [
      openServiceTab([], { sessionId: S1, serviceId: 'svc_1', name: 'dev' }).tabs[0],
    ])
    const again = withBucketTabs(
      { [key]: { tabs: scoped, activeId: null, open: true } },
      key,
      // 宿主重复点同一行：`openServiceTab` 按「会话 + 服务」找，不会因为前缀不同而再开一份
      openServiceTab(scoped, { sessionId: S1, serviceId: 'svc_1', name: 'dev' }),
    )
    expect(bucketOf(again, key).tabs.length).toBe(1)
    expect(bucketOf(again, key).activeId).toBe(scoped[0].id)
  })
})
