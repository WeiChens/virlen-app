/**
 * 「忽略沙盒命令」Tab 渲染 + store / repo 往返回归
 *
 * 钉住四件事：
 *  1. 列表渲染（空态与常用规则入口、合并后的类型徽标、拖拽把手与行内小开关、顺序提示）；
 *  2. store CRUD（新增 / 覆盖 / 启停 / 删除 / 上移下移 / 拖拽重排）落盘到 securityRepo；
 *  3. 存量配置缺 `sandboxIgnoreRules` 字段时 repo 能补默认值（老用户升级不炸）。
 *
 * ※ 弹窗内部（含匹配方式切换重置内容、JS 代码编辑器、删除二次确认）不做交互测试：
 *   本仓库未引入 @testing-library，同款断言下沉到了领域层（默认模板 / 写法宽容 / 编译校验）。
 * ※ 顺序调整的纯逻辑（相邻位移 / 拖拽落点 / 指示线位置）在
 *   `domain/sandbox-ignore-rules.test.ts` 与 `ui/sandbox-rules-dnd.test.ts`，
 *   这里只盖 store 到 repo 的落盘链路与静态 markup。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { runInAction } from 'mobx'

/** Monaco 在 jsdom 里跑不起来（缺 CSS.escape / canvas）——本页的 JS 规则用代码编辑器，
    模块引用链会间接拉进 monaco，故与其它 UI 测试同款替身 */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))

import SecuritySandboxRules from '@/ui/pages/Settings/security-sandbox-rules'
import { securityStore } from '@/ui/store/securityStore'
import { securityRepo } from '@/infrastructure/securityRepo'
import {
  createSandboxIgnoreRule,
  findMatchingSandboxRule,
  type SandboxIgnoreRule,
} from '@/domain/security/sandbox-ignore-rules'

const STORAGE_KEY = 'virlen-security'

function resetStore(): void {
  localStorage.removeItem(STORAGE_KEY)
  // value 是 observed observable（strict-mode 下必须在 action 里改），
  // 否则会打 MobX 告警 —— 测试同理，用 runInAction 包一层
  runInAction(() => {
    securityStore.value = {
      whitelist: [],
      blacklist: [],
      skipEachDirs: [],
      sandboxIgnoreRules: [],
    }
  })
}

function render() {
  return renderToStaticMarkup(<SecuritySandboxRules />)
}

function rule(patch: Partial<SandboxIgnoreRule> = {}): SandboxIgnoreRule {
  return {
    ...createSandboxIgnoreRule(),
    name: patch.name ?? 'npm 安装',
    kind: patch.kind ?? 'text',
    pattern: patch.pattern ?? 'npm install',
    ...patch,
  }
}

beforeEach(() => {
  resetStore()
})

describe('忽略沙盒命令 Tab', () => {
  it('无规则时渲染空态、常用规则入口与计数', () => {
    const html = render()
    expect(html).toContain('忽略沙盒命令')
    expect(html).toContain('还没有规则')
    expect(html).toContain('常用规则（点击添加）')
    expect(html).toContain('共 0 条规则')
    // 空态里给出可直接点的起点（名称来自 SANDBOX_RULE_PRESETS）
    expect(html).toContain('安装依赖')
    expect(html).toContain('运行测试')
    // 只有一条及以下时无所谓优先级，不占位置
    expect(html).not.toContain('从上到下依次匹配')
  })

  it('渲染规则名称与合并后的类型徽标，禁用规则带 is-disabled', () => {
    securityStore.upsertSandboxRule(
      rule({ name: 'pnpm 依赖', pattern: 'pnpm', textMode: 'prefix' }),
    )
    securityStore.upsertSandboxRule(
      rule({ name: '测试正则', kind: 'regex', pattern: '^npm test' }),
    )
    securityStore.upsertSandboxRule(
      rule({ name: '停用的', kind: 'js', pattern: 'true', enabled: false }),
    )

    const html = render()
    expect(html).toContain('pnpm 依赖')
    expect(html).toContain('测试正则')
    // 类型 + 比较方式合并为一个徽标（分开渲染会挤掉规则名）
    expect(html).toContain('rule-badge">文本 · 前缀</span>')
    expect(html).toContain('rule-badge">正则</span>')
    expect(html).toContain('rule-badge">JS</span>')
    expect(html).toContain('共 3 条规则（2 条已启用）')
    // 多于一条时给出排序语义提示
    expect(html).toContain('从上到下依次匹配')
    // 命中「禁用态」的只有停用的那条
    expect(html.split('is-disabled').length - 1).toBe(1)
  })

  it('列表项用拖拽把手排序，开关移到行尾且为小尺寸（已无上下移按钮）', () => {
    securityStore.upsertSandboxRule(rule({ name: 'A' }))
    securityStore.upsertSandboxRule(rule({ name: 'B', pattern: 'go test' }))
    const html = render()

    // 拖拽把手：可聚焦（键盘可达）+ 提示可用方向键
    expect(html).toContain('class="rule-grip"')
    expect(html).toContain('拖动排序（或用上下方向键）')
    expect(html).toContain('role="button"')
    // 上下移按钮已移除（排序改拖拽）
    expect(html).not.toContain('上移')
    expect(html).not.toContain('下移')

    // 开关：公共组件 Toggle 的小尺寸 + switch 语义
    expect(html).toContain('virlen-toggle size-sm')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    // 节点顺序：内容 → 开关 → 编辑/删除（开关在图标按钮之前）
    expect(html.indexOf('virlen-toggle')).toBeLessThan(
      html.indexOf('rule-icon-btn'),
    )
  })
})

describe('securityStore · 规则 CRUD', () => {
  it('新增 / 覆盖 / 启停 / 删除，并落盘到 repo', () => {
    const a = rule({ name: 'A' })
    securityStore.upsertSandboxRule(a)
    securityStore.upsertSandboxRule(rule({ name: 'B', pattern: 'go test' }))
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual(['A', 'B'])

    // 同 id 覆盖（编辑）
    securityStore.upsertSandboxRule({ ...a, name: 'A2' })
    expect(securityStore.sandboxIgnoreRules).toHaveLength(2)
    expect(securityStore.sandboxIgnoreRules[0].name).toBe('A2')

    // 启停
    securityStore.setSandboxRuleEnabled(a.id, false)
    expect(securityStore.sandboxIgnoreRules[0].enabled).toBe(false)

    // 删除
    securityStore.removeSandboxRule(a.id)
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual(['B'])

    // 落盘：repo 读回的是同一份数据（不是内存副本）
    expect(securityRepo.load().sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'B',
    ])
  })

  it('写入的规则能被匹配器读到（组件 → store → 匹配器闭环）', () => {
    securityStore.upsertSandboxRule(
      rule({ name: '装依赖', pattern: 'pnpm', textMode: 'prefix' }),
    )
    const hit = findMatchingSandboxRule(
      securityStore.sandboxIgnoreRules,
      'pnpm install --frozen-lockfile',
    )
    expect(hit?.name).toBe('装依赖')
    expect(
      findMatchingSandboxRule(securityStore.sandboxIgnoreRules, 'npm install'),
    ).toBeNull()
  })

  it('上移 / 下移改顺序并落盘（越界不改动也不落库）', () => {
    const a = rule({ name: 'A' })
    securityStore.upsertSandboxRule(a)
    securityStore.upsertSandboxRule(rule({ name: 'B', pattern: 'go test' }))

    // 首条上移：越界 → 顺序不变
    securityStore.moveSandboxRule(a.id, -1)
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'A',
      'B',
    ])

    securityStore.moveSandboxRule(a.id, 1)
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'B',
      'A',
    ])

    securityStore.moveSandboxRule(a.id, -1)
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'A',
      'B',
    ])

    // 落盘：repo 读回的是新顺序
    expect(securityRepo.load().sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'A',
      'B',
    ])
  })

  it('拖拽落点重排并落盘（reorderSandboxRule）', () => {
    const a = rule({ name: 'A' })
    securityStore.upsertSandboxRule(a)
    securityStore.upsertSandboxRule(rule({ name: 'B' }))
    securityStore.upsertSandboxRule(rule({ name: 'C' }))

    // 把 A 拖到末尾（第 3 个间隙）
    securityStore.reorderSandboxRule(a.id, 3)
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'B',
      'C',
      'A',
    ])
    expect(securityRepo.load().sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'B',
      'C',
      'A',
    ])

    // 拖到自己原位的前后两个间隙 → 顺序不变
    securityStore.reorderSandboxRule(a.id, 2)
    securityStore.reorderSandboxRule(a.id, 3)
    expect(securityStore.sandboxIgnoreRules.map((r) => r.name)).toEqual([
      'B',
      'C',
      'A',
    ])
  })
})

describe('securityRepo · 存量配置兼容', () => {
  it('缺 sandboxIgnoreRules 字段时补空数组（老用户升级）', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ whitelist: ['C:/x'], blacklist: [], skipEachDirs: [] }),
    )
    const cfg = securityRepo.load()
    expect(cfg.sandboxIgnoreRules).toEqual([])
    expect(cfg.whitelist).toEqual(['C:/x'])
    expect(Array.isArray(cfg.skipEachDirs)).toBe(true)
  })

  it('字段类型异常（非数组）时也回退空数组', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sandboxIgnoreRules: null }),
    )
    expect(securityRepo.load().sandboxIgnoreRules).toEqual([])
  })
})
