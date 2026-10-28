// @vitest-environment node
/**
 * 侧栏的「那个对话的右侧栏还开着」徽标（标签属于会话，面板一次只显示一个）。
 *
 * 守四条用户可见的承诺：
 *  1. **只给非当前会话**：当前会话的标签数在工具栏那颗按钮上，两处说同一件事就是噪音；
 *  2. **收起 / 展开分两档**：`is-collapsed` 是「标签挂着但没摊开」，不然用户会以为它当着面开着；
 *  3. **点徽标 = 切过去 + 展开**：自带动作，不能顺带把整行那个「选中会话」再跑一遍
 *     （`stopPropagation`），否则「展开面板」与「切换会话」两个副作用谁先谁后说不清；
 *  4. **折叠分组头有汇总**：分组折起来之后，组里那些标签栏否则完全隐形。
 *
 * 这里用源码断言而不是挂整个侧栏：jsdom 里要拖起目录树 / 技能列表 / RAG 服务，成本远大于收益
 *（口径同 `sidebar-status-flag.test.ts`）。纯函数那一半在 `side-panel-sessions.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

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
const STYLE = 'src/ui/pages/chat/components/sidebar/style.scss'
const CHAT_VIEW = 'src/ui/pages/chat/chat-view.tsx'
const I18N = 'src/ui/i18n/lang/en-US.json'

const src = readProjectFile(SIDEBAR)
const chatView = readProjectFile(CHAT_VIEW)
const css = sass.compileString(readProjectFile(STYLE)).css
const en = JSON.parse(readProjectFile(I18N)) as Record<string, string>

describe('侧栏标签徽标：只给别的会话，且分「展开 / 收起」两档', () => {
  it('会话项只在「非当前会话」时取这一桶的摘要', () => {
    expect(src).toContain('const panel = isCurrent ? undefined : panelTabs?.[session.id]')
    // 反向断言：整行不能无条件读 summary（那会把当前会话也画上一枚）
    expect(src).not.toMatch(/const panel = panelTabs\?\.\[session\.id\]/)
  })

  it('徽标是「面板图标 + 标签数」的真按钮，收起态挂 is-collapsed', () => {
    const badge = /className=\{`session-panel-badge\$\{panel\.open \? '' : ' is-collapsed'\}`\}/.test(
      src,
    )
    expect(badge).toBe(true)
    expect(src).toContain('<PanelRightSvg />')
    expect(src).toContain('<span className="session-panel-badge-count">{panel.count}</span>')
    // 真按钮（行本身是 div，所以「按钮里放按钮」不成立），键盘可达
    expect(src).toMatch(/<button\s+type="button"\s+className=\{`session-panel-badge/)
  })

  it('点徽标先拦住冒泡，再上报「切过去并展开」；拖完那一下 click 不算打开', () => {
    expect(src).toContain('e.stopPropagation()')
    expect(src).toContain('if (badgeDragJustEnded()) return')
    // 顺序是契约：先判「刚才在拖」，再打开面板
    const suppress = src.indexOf('if (badgeDragJustEnded()) return')
    const open = src.indexOf('onOpenSessionPanel?.(session.id)')
    expect(suppress).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(suppress)
  })

  /**
   * 按住徽标可以拖：拖到**标签栏** = 把那一批搬进当前会话；拖到**另一个会话行** = 搬去那个会话。
   * 落点判定 / 浮层都在 `sidebar/session-badge-drag.ts`（用例见 `session-badge-drag.test.ts`）。
   */
  it('按住徽标可拖：两个落点都接上，光标先说明「抓得起来」', () => {
    expect(src).toContain('onMouseDown={(e) =>')
    expect(src).toContain('startSessionBadgeDrag(e, {')
    expect(src).toContain('fromSessionId: session.id')
    // 拖到标签栏时目标就是「当前会话」（新对话页则是 null，由宿主用 panelKeyOf 解）
    expect(src).toContain("target.kind === 'session' ? target.sessionId : chatState.value.currentSessionId")
    expect(src).toContain('onTransferSessionTabs(')
    expect(css).toMatch(/\.session-panel-badge \{[\s\S]*?cursor: grab/)
  })

  it('折叠分组头挂汇总（展开时每个会话行自己会说）', () => {
    expect(src).toContain('{isCollapsed && panelTabCount > 0 && (')
    expect(src).toContain('className="group-panel-badge"')
    // 汇总 = 组内各会话的标签数之和（不是「有标签的会话数」）
    expect(src).toMatch(
      /group\.sessions\.reduce\(\(sum, s\) => sum \+ \(panelTabs\[s\.id\]\?\.count \?\? 0\), 0\)/,
    )
  })

  it('分组头里的位置：靠右、紧贴会话数（group-name 是 flex:1，放它后面就贴右）', () => {
    const name = src.indexOf('<span className="group-name">{group.name}</span>')
    const badge = src.indexOf('className="group-panel-badge"')
    const count = src.indexOf('<span className="group-count">')
    expect(name).toBeGreaterThan(-1)
    expect(badge).toBeGreaterThan(name)
    expect(count).toBeGreaterThan(badge)
  })

  it('两档配色都在样式表里：展开 = 品牌薄涂，收起 = 只留描边 + 不接指针', () => {
    expect(css).toMatch(/\.session-item \.session-panel-badge \{/)
    expect(css).toMatch(/\.session-panel-badge \{[\s\S]*?color-mix\(in srgb, var\(--primary/)
    expect(css).toMatch(
      /\.session-panel-badge\.is-collapsed \{[\s\S]*?background: transparent[\s\S]*?box-shadow: inset/,
    )
    // 分组头那枚只是计数：点它 = 折叠 / 展开分组，不能替用户挑一个会话
    expect(css).toMatch(/\.group-panel-badge \{[\s\S]*?pointer-events: none/)
  })

  it('分组头那枚与 `group-count` 同一套读数：底色 / 文字色 / 字号都一致', () => {
    const block = (selector: string) =>
      new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const count = block('.group-count')
    const badge = block('.group-panel-badge')
    expect(count).not.toBe('')
    for (const decl of [
      'background: var(--hover-bg, #e8e8e8)',
      'color: var(--text-secondary, #999)',
      'font-size: var(--font-size-xs)',
      'border-radius: 10px',
    ]) {
      expect(count, `group-count 缺 ${decl}`).toContain(decl)
      expect(badge, `group-panel-badge 少了与 group-count 一致的 ${decl}`).toContain(decl)
    }
  })
})

describe('chat-view 的接线：摘要来自唯一真相，跳转一次落地', () => {
  it('摘要由 `panelTabSummaries(panelBuckets)` 算、传给侧栏与两个跳转入口', () => {
    expect(chatView).toContain(
      'const panelTabCounts = useMemo(() => panelTabSummaries(panelBuckets), [panelBuckets])',
    )
    expect(chatView).toContain('panelTabs={panelTabCounts}')
    expect(chatView).toContain('onOpenSessionPanel={handleOpenSessionPanel}')
    expect(chatView).toContain('onOpenOtherTab={handleOpenSessionPanel}')
  })

  it('跳转 = 先改桶（展开 + 激活）再切会话，同一个同步块', () => {
    const handler =
      /function handleOpenSessionPanel\(sessionId: string, tabId\?: string\) \{[\s\S]*?withBucketActive\(current, sessionId, tabId\)[\s\S]*?withBucketOpen\(current, sessionId, true\)[\s\S]*?void handleSelectSession\(sessionId\)/.test(
        chatView,
      )
    expect(handler).toBe(true)
  })

  it('新对话页那一桶（没有 sessionId）：走「新建对话」同一条路，不能丢给 handleSelectSession', () => {
    // 顺序也是契约：早返回在前，`handleSelectSession` 在后
    expect(chatView).toMatch(
      /if \(sessionId === NEW_PANEL_KEY\) \{[\s\S]*?return\s*\}\s*void handleSelectSession\(sessionId\)/,
    )
    // 分支里只置空 currentSessionId（与侧栏「新建对话」/ Ctrl+N 同一条路）
    expect(chatView).toMatch(
      /if \(sessionId === NEW_PANEL_KEY\) \{[\s\S]*?chatState\.set\(\{ currentSessionId: null, error: null \}\)/,
    )
    // `handledSessionRef` 必须归零：否则外部入口再打开刚离开的那个会话会被兜底 effect 跳过
    expect(chatView).toMatch(
      /if \(sessionId === NEW_PANEL_KEY\) \{[\s\S]*?handledSessionRef\.current = null/,
    )
  })

  it('开始页清单跳过当前桶、跳过开始页标签，并带上会话标题', () => {
    expect(chatView).toContain('parkedBucketsOf(panelBuckets, panelKey)')
    expect(chatView).toContain("tabs: tabs.filter((tab) => tab.kind !== 'guide')")
    expect(chatView).toContain("sessionStore.getSession(key)?.title || key")
    // 新对话页那一桶没有会话对象：标题给「新对话」，否则会显示成 `__new__`
    expect(chatView).toMatch(/key === NEW_PANEL_KEY\s*\? t\('新对话'\)/)
  })

  it('徽标拖动 = 整批转移：走 `transferSessionTabs`（同内容不搬、部分成功也算搬成）', () => {
    expect(chatView).toContain('const handleTransferSessionTabs = useCallback(')
    expect(chatView).toContain('transferSessionTabs(')
    expect(chatView).toContain('onTransferSessionTabs={handleTransferSessionTabs}')
    // 全重复才提示一句（标签凭空不动才像拖坏了）
    expect(chatView).toContain('这些标签都已经在目标会话里打开了')
  })

  /**
   * 「搬进当前会话」的两块落点都得登记：标签栏（面板）与聊天区（聊天页）。
   * 漏了聊天区那一条，用户就只能去命中 36px 高的标签栏；漏了标签栏，最精确的那个也没了。
   */
  it('两块「当前会话」落点都登记：面板登标签栏、聊天页登 chat-main', () => {
    expect(chatView).toContain("registerDropArea('chat-main', () => chatMainRef.current)")
    expect(chatView).toContain('ref={chatMainRef}')
    const panel = readProjectFile('src/ui/pages/chat/components/side-panel/index.tsx')
    expect(panel).toContain("registerDropArea('tabbar', () => tabsRef.current)")
    // 聊天区的高亮是整块透一层（`::after`，内阴影会被子元素背景盖住）
    const chatCss = sass.compileString(readProjectFile('src/ui/pages/chat/chat-view.scss')).css
    expect(chatCss).toMatch(/\.chat-main\.is-drop-target::after \{/)
    expect(chatCss).toMatch(/\.chat-main\.is-drop-target::after \{[\s\S]*?pointer-events: none/)
  })
})

describe('新文案已登记（中文即 key）', () => {
  it.each([
    '右侧栏打开着 $__count__ 个标签页',
    '右侧栏已收起，还有 $__count__ 个标签页',
    '组内还有 $__count__ 个右侧栏标签页',
    '其他对话的标签页',
    '切到该对话并打开 $__name__',
    '这些标签都已经在目标会话里打开了',
  ])('%s', (key) => {
    expect(en[key], `${key} 未登记到 en-US.json`).toBeTruthy()
  })
})
