/**
 * 终端类型（`cmd` / `powershell` / `pwsh` / `git bash`）的**界面层**与开始页的「类型菜单」。
 *
 * 五条被钉住的口径：
 * 1. **展示名在前端**：Rust 只给稳定 id，`shellLabel` 负责 id → 名字；不认识的 id 原样显示
 *    （诊断时一眼能看出后端多给了一种）；
 * 2. **装了的在前、没装的沉底且灰显**，未装的项标「未安装」、悬停能看到「查过哪些目录」；
 * 3. **标出「上次使用」**（`Ctrl + \`` 开的就是它）；从没用过时标后端给的「默认」；
 * 4. **`Ctrl + \`` 不弹菜单**：显式选的 > 上次记的 > 让后端定（`resolveShellChoice`）；
 * 5. **整行点下去 = 直开默认那种，标题后面的 ▾ 才问类型**；探测不到（非桌面环境）或
 *    列不出来就直接开默认那种，不能让人点了没反应；没有 `loadShells` 就干脆不画 ▾。
 */
import { afterEach, beforeAll, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import Guide from '@/ui/pages/chat/components/side-panel/guide'
import {
  orderShells,
  preferredShellId,
  resolveShellChoice,
  shellLabel,
  shellMenuItems,
} from '@/ui/pages/chat/components/terminal/shells'
import type { UserTerminalShell } from '@/infrastructure/terminal'
import { settingsState } from '@/ui/store/settingStore'

// 显式告诉 React 这是 act 环境（否则每次 `act()` 都会打一条警告）
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 造一个探测结果（默认「装了」，路径随便给一个绝对路径） */
function shell(
  id: string,
  extra: Partial<UserTerminalShell> = {},
): UserTerminalShell {
  return {
    id,
    exe: `${id}.exe`,
    available: true,
    command: `C:/fake/${id}.exe`,
    args: [],
    default: false,
    hint: null,
    ...extra,
  }
}

const SHELLS: UserTerminalShell[] = [
  shell('powershell', { default: true, exe: 'powershell.exe' }),
  shell('cmd'),
  shell('pwsh', {
    available: false,
    command: '',
    exe: 'pwsh.exe',
    hint: '没找到 pwsh.exe（查过 PATH 与 C:\\Program Files\\PowerShell\\7）',
  }),
  shell('gitbash', {
    available: false,
    command: '',
    exe: 'bash.exe',
    hint: '没找到 bash.exe（查过 PATH）',
  }),
]

beforeAll(() => {
  // jsdom 没布局：菜单定位靠 offsetWidth（0）与 clientRect，都不影响这里的断言
  Element.prototype.getBoundingClientRect = () =>
    ({
      left: 10,
      right: 210,
      width: 200,
      top: 20,
      bottom: 60,
      height: 40,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }) as DOMRect
})

afterEach(() => {
  settingsState.setValue('terminalShell', '')
})

// ==================== 纯函数 ====================

it('展示名：四种 id 都有人话，不认识的 id 原样显示', () => {
  expect(shellLabel('powershell')).toBe('Windows PowerShell')
  expect(shellLabel('cmd')).toBe('命令提示符')
  expect(shellLabel('pwsh')).toBe('PowerShell 7')
  expect(shellLabel('gitbash')).toBe('Git Bash')
  // 后端多给一种类型时不该假装它是默认那种
  expect(shellLabel('fish')).toBe('fish')
})

it('排序与首选：装了的在前，首选优先「后端标的默认」', () => {
  expect(orderShells(SHELLS).map((s) => s.id)).toEqual([
    'powershell',
    'cmd',
    'pwsh',
    'gitbash',
  ])

  expect(preferredShellId(SHELLS)).toBe('powershell')
  // 默认那种没装 → 退到第一个可用的
  expect(
    preferredShellId([
      shell('powershell', { available: false, command: '' }),
      shell('cmd'),
    ]),
  ).toBe('cmd')
  // 一个可用的都没有 → undefined（让后端自己兜底 / 如实报错）
  expect(
    preferredShellId([shell('gitbash', { available: false, command: '' })]),
  ).toBeUndefined()
})

it('这次开哪种：显式选的 > 上次记的 > 让后端定（空串当没选）', () => {
  expect(resolveShellChoice('gitbash', 'cmd')).toBe('gitbash')
  expect(resolveShellChoice(undefined, 'cmd')).toBe('cmd')
  expect(resolveShellChoice('', 'cmd')).toBe('cmd')
  expect(resolveShellChoice(undefined, '')).toBeUndefined()
  expect(resolveShellChoice('  ', '  ')).toBeUndefined()
})

it('菜单项：未安装的灰显 + 标「未安装」+ 悬停给原因；上次使用 / 默认各自标注', () => {
  const picked: string[] = []

  const items = shellMenuItems({
    shells: SHELLS,
    lastUsed: 'cmd',
    onPick: (id) => picked.push(id),
  })
  expect(items.map((i) => i.key)).toEqual(['powershell', 'cmd', 'pwsh', 'gitbash'])
  expect(items.map((i) => i.disabled)).toEqual([false, false, true, true])

  const texts = items.map((i) => String((i.label as any).props?.children ?? i.label))
  // 上次用的那种被标出来，其余可用项是纯名字
  expect(texts[0]).toBe('Windows PowerShell')
  expect(texts[1]).toBe('命令提示符（上次使用）')
  expect(texts[2]).toBe('PowerShell 7（未安装）')
  // 未安装的项把原因挂在 title 上（查过哪些目录）
  expect((items[2].label as any).props.title).toContain('没找到 pwsh.exe')

  items[1].onClick()
  expect(picked).toEqual(['cmd'])
})

it('菜单项：从没用过时把「默认」标出来（第一次打开菜单也能看出按键会开哪个）', () => {
  const items = shellMenuItems({ shells: SHELLS, onPick: () => {} })
  expect(String((items[0].label as any).props?.children ?? items[0].label)).toBe(
    'Windows PowerShell（默认）',
  )
})

// ==================== 开始页的类型菜单 ====================

let root: ReturnType<typeof createRoot> | null = null
const picked: Array<[string, string | undefined]> = []

async function renderGuide(loadShells?: () => Promise<UserTerminalShell[]>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <Guide
        onPick={(kind, shellId) => picked.push([kind, shellId])}
        workspaceReady
        loadShells={loadShells}
      />,
    )
  })
}

const entry = (kind: string) =>
  document.querySelector<HTMLElement>(`.panel-guide-entry[data-guide-entry="${kind}"]`)
/** 主操作那层（铺满整行的真按钮）：点它 = 直接开默认那种 */
const hit = (kind: string) =>
  entry(kind)?.querySelector<HTMLButtonElement>('.panel-guide-entry-hit') ?? null
/** 标题后面那颗 ▾：点它才弹类型菜单 */
const caret = () =>
  document.querySelector<HTMLButtonElement>('.panel-guide-entry-caret')
const menuItems = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.context-menu .context-menu-item'),
]

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  picked.length = 0
})

it('开始页：点整行直接开默认终端（不弹菜单、不带 shell id）', async () => {
  settingsState.setValue('terminalShell', 'cmd')
  await renderGuide(async () => SHELLS)

  await act(async () => {
    hit('terminal')!.click()
  })
  // 一个菜单也不该出现：多数人只是想再开一个终端，不该为此多点一次
  expect(menuItems()).toEqual([])
  expect(picked).toEqual([['terminal', undefined]])
})

it('开始页：点标题后的 ▾ 才弹类型菜单，选中一种才开（带 id 上报宿主）', async () => {
  settingsState.setValue('terminalShell', 'cmd')
  await renderGuide(async () => SHELLS)

  await act(async () => {
    caret()!.click()
  })
  expect(menuItems().map((b) => b.textContent)).toEqual([
    'Windows PowerShell',
    '命令提示符（上次使用）',
    'PowerShell 7（未安装）',
    'Git Bash（未安装）',
  ])
  // 没点之前一个终端也不该开
  expect(picked).toEqual([])

  // 点「未安装」那种：不响应（灰显的按钮点不动）
  await act(async () => menuItems()[2].click())
  expect(picked).toEqual([])

  // 点安装好的那种：带 id 上报，菜单随之关掉
  await act(async () => menuItems()[1].click())
  expect(picked).toEqual([['terminal', 'cmd']])
  expect(menuItems()).toEqual([])
})

it('开始页：菜单开着时再点一次 ▾ 就关掉（不会先关又开）', async () => {
  await renderGuide(async () => SHELLS)

  await act(async () => {
    caret()!.click()
  })
  expect(menuItems()).toHaveLength(4)

  await act(async () => {
    caret()!.click()
  })
  expect(menuItems()).toEqual([])
  expect(picked).toEqual([])
})

it('开始页：只有终端有 ▾，文件与浏览器没有（那两格没有类型可挑）', async () => {
  await renderGuide(async () => SHELLS)

  expect(caret()).not.toBeNull()
  expect(entry('files')!.querySelector('.panel-guide-entry-caret')).toBeNull()
  expect(entry('browser')!.querySelector('.panel-guide-entry-caret')).toBeNull()
})

it('开始页：探测不到类型列表就直接开默认终端（点了必须有反应）', async () => {
  await renderGuide(async () => [])

  await act(async () => {
    caret()!.click()
  })
  expect(menuItems()).toEqual([])
  expect(picked).toEqual([['terminal', undefined]])
})

it('开始页：一个 shell 都用不了（非 Windows）不弹全灰的菜单，让后端如实报错', async () => {
  await renderGuide(async () => [
    shell('powershell', { available: false, command: '', hint: '只在 Windows 上' }),
    shell('cmd', { available: false, command: '', hint: '只在 Windows 上' }),
  ])

  await act(async () => {
    caret()!.click()
  })
  expect(menuItems()).toEqual([])
  expect(picked).toEqual([['terminal', undefined]])
})

it('开始页：没有 loadShells（非桌面 / 老调用点）就没菜单可弹 —— 连 ▾ 也不画，整行直开默认', async () => {
  await renderGuide(undefined)

  expect(caret()).toBeNull()
  await act(async () => {
    hit('terminal')!.click()
  })
  expect(menuItems()).toEqual([])
  expect(picked).toEqual([['terminal', undefined]])
})

it('开始页：文件与浏览器不受影响（照旧直接上报，不弹菜单）', async () => {
  await renderGuide(async () => SHELLS)

  await act(async () => {
    hit('files')!.click()
    hit('browser')!.click()
  })
  expect(picked).toEqual([
    ['files', undefined],
    ['browser', undefined],
  ])
  expect(menuItems()).toEqual([])
})
