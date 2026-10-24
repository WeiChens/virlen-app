/**
 * 右侧栏的命令表 —— **键帽显示与实际键盘匹配读同一份**。
 *
 * 为什么要有这一层：开始页的胶囊右侧要画 `Ctrl + Shift + E` 这样的键帽，
 * 而真正接管键盘的是 `chat-view` 里的 `keydown`。两边各写一份必然漂移
 * （参考实现把这件事做成了命令注册表：`defaults` 与 `<ShortcutKeys>` 同源）。
 *
 * 只覆盖「右侧栏」这几条：项目里别处的快捷键（`Ctrl+P` 检索、`Ctrl+N` 新对话、
 * `useZoom` 的缩放）暂时保持原样，等后面统一迁移时一并收进来。
 */

/** 是否 macOS：决定主修饰键渲染成 `⌘` 还是 `Ctrl`，以及匹配时认 meta 还是 ctrl */
export const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '')

export type PanelCommandId =
  | 'panel.files'
  | 'panel.toggle'
  | 'panel.terminal'
  | 'panel.browser'

export interface PanelCommand {
  id: PanelCommandId
  /** 展示用键帽；`'primary'` 按平台渲染成 `Ctrl` / `⌘` */
  keys: string[]
  /** 主键看 `KeyboardEvent.code`：键盘布局无关（中文输入法 / 非拉丁布局下 `key` 不可靠） */
  code: string
  /** 必须按下的修饰键；`'primary'` = Windows/Linux 的 Ctrl、macOS 的 Cmd */
  modifiers: Array<'primary' | 'shift' | 'alt'>
  /** 尚未接入：键帽照常显示，入口在开始页里禁用（不假装能用） */
  pending?: boolean
}

/**
 * 当前键位（P0 口径）：
 *
 * - **工作区文件用 `Ctrl+Shift+E`，不是参考实现的 `Ctrl+P`** —— 本项目 `Ctrl+P` 已经是
 *   「消息检索」（`chat-view` 里注册）。抢占它会静默改掉老用户的手感，必须单独拍板；
 *   真要换只在下面这一行改。
 * - 收起/展开用 `Ctrl+Alt+B`：`Ctrl+B` 在 Monaco 里有语义，避开。
 * - 浏览器用 `Ctrl+T`：WebView 没有工具栏的「新标签」语义，本项目也没占过它；
 * - 新建终端用 `Ctrl + \``：`useZoom` 只占 `Ctrl+=/-/0`，不冲突。
 */
export const PANEL_COMMANDS: Record<PanelCommandId, PanelCommand> = {
  'panel.files': {
    id: 'panel.files',
    keys: ['primary', 'Shift', 'E'],
    code: 'KeyE',
    modifiers: ['primary', 'shift'],
  },
  'panel.toggle': {
    id: 'panel.toggle',
    keys: ['primary', 'Alt', 'B'],
    code: 'KeyB',
    modifiers: ['primary', 'alt'],
  },
  'panel.terminal': {
    id: 'panel.terminal',
    keys: ['primary', '`'],
    code: 'Backquote',
    modifiers: ['primary'],
  },
  'panel.browser': {
    id: 'panel.browser',
    keys: ['primary', 'T'],
    code: 'KeyT',
    modifiers: ['primary'],
  },
}

/** 把命令的键帽转成展示文本（`primary` 按平台换成 Ctrl / ⌘） */
export function keycaps(command: PanelCommand, isMac = IS_MAC): string[] {
  return command.keys.map((key) =>
    key === 'primary' ? (isMac ? '⌘' : 'Ctrl') : key,
  )
}

/**
 * 这次按键是否命中该命令。
 *
 * 判定是「恰好」而不是「至少」：多按了别的修饰键就不算，否则 `Ctrl+Shift+E`
 * 会被 `Ctrl+E` 之类的命令顺手截走（项目里以后只会越来越挤）。
 */
export function matchesCommand(
  event: KeyboardEvent,
  command: PanelCommand,
  isMac = IS_MAC,
): boolean {
  const primary = isMac ? event.metaKey : event.ctrlKey
  if (!primary) return false
  // 另一个主修饰键不许同时按着（Windows 的 AltGr 也不会命中这些组合）
  if (isMac ? event.ctrlKey : event.metaKey) return false
  if (event.shiftKey !== command.modifiers.includes('shift')) return false
  if (event.altKey !== command.modifiers.includes('alt')) return false
  return event.code === command.code
}

/**
 * 焦点在「会吃掉这个键」的地方：输入框、文本域、可编辑区、终端。
 *
 * 终端里 `Ctrl+Shift+E` 之类虽然在 shell 里没意义，但 `Ctrl+B`/`Ctrl+E` 有
 * （readline 的行首行尾），所以终端整块让路，别在用户敲命令时劫持键盘。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.closest('.xterm')) return true
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return el.isContentEditable === true
}
