/**
 * Guide — 右侧面板的「开始页」（标签 kind = `guide`）。
 *
 * 这是从 deepseek-harness 的右侧栏学来的形态：面板空出来时不是一片空白，而是三扇门 ——
 * 工作区文件 / 新建终端 / 浏览器，每扇门右侧标着自己的快捷键。点一扇门就把它**原地**
 * 换成那个页面（见 `tabs.ts::replacePageTab`），所以开始页是门厅，不是常驻页面。
 *
 * 四条刻意的取舍：
 * 1. **入口写死在这张表里**，不造「tab 类型注册表」—— 只有三个入口，注册表带来的抽象
 *    成本远大于收益（参考实现有几十个包要贡献入口，才需要那层）；
 * 2. **键帽从 `shortcuts/commands.ts` 取**，与实际 `keydown` 匹配同源，
 *    避免「胶囊写着 Ctrl+P、按下去没反应」这类漂移；
 * 3. **每个入口都是真的**：三扇门分别开文件树、交互终端与网页（浏览器的兜底提示见
 *    `browser/BrowserPane` 文件头）。`command.pending` 这条开关还留着 —— 以后再加入口
 *    （比如「差异」）可以先上胶囊、再接入，但**不能**拿它假装一个入口能用。
 * 4. **「新建终端」先问类型再开**：终端有四种（cmd / powershell / pwsh / git bash），
 *    后两种要另外安装 —— 点这一格先弹一个小菜单，没装的灰显并标「未安装」。
 *    类型列表由宿主经 `loadShells` 注入（缺省 = 不弹菜单、直接开默认那种）：
 *    开始页只管「点了哪一格、落在哪儿」，探测与记忆都在上层。
 */
import { useState, type ComponentType, type MouseEvent } from 'react'
import { t } from '@/ui/i18n'
import { keycaps, PANEL_COMMANDS, type PanelCommandId } from '@/ui/shortcuts/commands'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import type { UserTerminalShell } from '@/infrastructure/terminal'
import { settingsState } from '@/ui/store/settingStore'
import CompassSvg from '@/ui/components/icons/CompassSvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import TerminalSvg from '@/ui/components/icons/TerminalSvg'
import GlobeSvg from '@/ui/components/icons/GlobeSvg'
import { shellMenuItems } from '../terminal/shells'
import './guide.scss'

type EntryKind = 'files' | 'terminal' | 'browser'

interface Entry {
  kind: EntryKind
  command: PanelCommandId
  icon: ComponentType<{ fill?: string; className?: string }>
  /** 标题与描述：中文即 key，英文由 `en-US.json` 提供 */
  label: string
  description: string
}

/** 三扇门的顺序与图标（顺序对齐参考实现：文件 10 / 终端 20 / 浏览器 30） */
const ENTRIES: Entry[] = [
  {
    kind: 'files',
    command: 'panel.files',
    icon: FolderSvg,
    label: '工作区文件',
    description: '浏览会话工作区的文件',
  },
  {
    kind: 'terminal',
    command: 'panel.terminal',
    icon: TerminalSvg,
    label: '新建终端',
    description: '在会话工作区运行命令',
  },
  {
    kind: 'browser',
    command: 'panel.browser',
    icon: GlobeSvg,
    label: '浏览器',
    description: '浏览网页',
  },
]

interface Props {
  /**
   * 点了一扇门：宿主负责把开始页原地换成目标页。
   * `shell` 只对终端有意义（用户在类型菜单里挑的那一种；不带 = 用上次的 / 默认的）。
   */
  onPick: (kind: EntryKind, shell?: string) => void
  /** 有没有可浏览的工作区：没有时「工作区文件」与「新建终端」都禁用并说明原因 */
  workspaceReady: boolean
  /**
   * 终端类型的加载器（探测「装没装」要问 Rust）。
   * 不传 = 不弹类型菜单，`onPick('terminal')` 直接用默认那种。
   */
  loadShells?: () => Promise<UserTerminalShell[]>
}

export default function Guide({ onPick, workspaceReady, loadShells }: Props) {
  const shellMenu = useContextMenu()
  const [shellItems, setShellItems] = useState<ContextMenuItem[]>([])

  /**
   * 点「新建终端」：先取类型列表，再在胶囊下方弹菜单。
   *
   * 三个细节：
   * - 锚点（`rect`）必须在 `await` **之前**取：事件对象里的 `currentTarget` 在 await 之后就没了；
   * - 列表取不到（非桌面环境 / 命令失败）或**一个能用的都没有**，就直接开默认终端 ——
   *   不能让人点了没反应，也不能弹出一片全灰的菜单；
   * - 菜单项与位置在同一次更新里落地（React 18 会自动合并），不会先闪一个空菜单。
   */
  function handleTerminalPick(anchor: HTMLElement): void {
    if (!loadShells) {
      onPick('terminal')
      return
    }
    const rect = anchor.getBoundingClientRect()
    void (async () => {
      const shells = await loadShells()
      // 一个能用的都没有（非 Windows / 系统把 shell 都裁了）：不弹一片灰的菜单，
      // 直接开 —— 让后端把「平台不支持」这类原因如实说出来
      if (!shells.some((s) => s.available)) {
        onPick('terminal')
        return
      }
      setShellItems(
        shellMenuItems({
          shells,
          lastUsed: settingsState.value.terminalShell || undefined,
          onPick: (id) => onPick('terminal', id),
        }),
      )
      shellMenu.openAtPoint({ x: rect.left, y: rect.bottom + 4 }, undefined)
    })()
  }

  function handleEntryClick(entry: Entry, event: MouseEvent<HTMLButtonElement>): void {
    if (entry.kind === 'terminal') {
      handleTerminalPick(event.currentTarget)
      return
    }
    onPick(entry.kind)
  }

  return (
    <div className="panel-guide" data-panel-guide="">
      <span className="panel-guide-hero" aria-hidden="true">
        <CompassSvg />
      </span>

      <div className="panel-guide-list">
        {ENTRIES.map((entry) => {
          const command = PANEL_COMMANDS[entry.command]
          // 「文件」与「终端」都要一个工作目录（终端的工作目录就是会话工作区）；
          // 浏览器不需要，所以它现在**永远不会**禁用（三个入口都已接入）。
          const needsWorkspace = entry.kind !== 'browser'
          const noWorkspace = needsWorkspace && !workspaceReady
          const disabled = command.pending === true || noWorkspace
          const Icon = entry.icon
          const description = noWorkspace
            ? t('这个会话没有工作区目录。')
            : t(entry.description)

          return (
            <button
              key={entry.kind}
              type="button"
              className="panel-guide-entry"
              data-guide-entry={entry.kind}
              disabled={disabled}
              title={command.pending ? t('即将支持') : undefined}
              onClick={(event) => {
                if (disabled) return
                handleEntryClick(entry, event)
              }}>
              <span className="panel-guide-entry-icon">
                <Icon />
              </span>
              <span className="panel-guide-entry-text">
                <span className="panel-guide-entry-title">{t(entry.label)}</span>
                <span className="panel-guide-entry-desc">{description}</span>
              </span>
              {command.pending ? (
                <span className="panel-guide-entry-soon">{t('即将支持')}</span>
              ) : (
                <span className="panel-guide-keys" aria-hidden="true">
                  {keycaps(command).map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 终端类型菜单（没装的灰显）：位置贴着被点的胶囊，点外面 / Esc 关掉 */}
      {shellMenu.state && (
        <ContextMenu
          position={shellMenu.state.position}
          items={shellItems}
          onClose={shellMenu.close}
        />
      )}
    </div>
  )
}
