/**
 * Guide — 右侧面板的「开始页」（标签 kind = `guide`）。
 *
 * 这是从 deepseek-harness 的右侧栏学来的形态：面板空出来时不是一片空白，而是三扇门 ——
 * 工作区文件 / 新建终端 / 浏览器，每扇门右侧标着自己的快捷键。点一扇门就把它**原地**
 * 换成那个页面（见 `tabs.ts::replacePageTab`），所以开始页是门厅，不是常驻页面。
 *
 * 五条刻意的取舍：
 * 1. **入口写死在这张表里**，不造「tab 类型注册表」—— 只有三个入口，注册表带来的抽象
 *    成本远大于收益（参考实现有几十个包要贡献入口，才需要那层）；
 * 2. **键帽从 `shortcuts/commands.ts` 取**，与实际 `keydown` 匹配同源，
 *    避免「胶囊写着 Ctrl+P、按下去没反应」这类漂移；
 * 3. **每个入口都是真的**：三扇门分别开文件树、交互终端与网页（浏览器的兜底提示见
 *    `browser/BrowserPane` 文件头）。`command.pending` 这条开关还留着 —— 以后再加入口
 *    （比如「差异」）可以先上胶囊、再接入，但**不能**拿它假装一个入口能用。
 * 4. **「新建终端」是「整行直开 + 一个 ▾ 挑类型」**：终端有四种（cmd / powershell / pwsh /
 *    git bash），后两种要另外安装 —— 但**多数人只是想再开一个终端**，所以点整行就按
 *    「上次用的 → 后端默认」直接开，标题后面那颗 ▾ 才弹类型菜单（没装的灰显并标「未安装」）。
 *    类型列表由宿主经 `loadShells` 注入（缺省 = 连 ▾ 都不画，因为没菜单可弹）：
 *    开始页只管「点了哪一格、落在哪儿」，探测与记忆都在上层。
 * 5. **一扇门 = 同一格网格上叠两层**：铺满整行的 `-hit` 真按钮负责主操作（可 disabled、
 *    键盘可达），`-body` 是看得见的内容层（`pointer-events: none`，只有 ▾ 例外）。
 *    不写成「一个 button 里再塞一个 button」：HTML 不允许（解析器会把外层提前闭合），
 *    而 ▾ 必须是自己能点的控件 —— 「开一个终端」与「挑哪种终端」是两件事。
 */
import { useRef, useState, type ComponentType } from 'react'
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
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
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
    description: '浏览当前对话工作区的文件',
  },
  {
    kind: 'terminal',
    command: 'panel.terminal',
    icon: TerminalSvg,
    label: '新建终端',
    description: '在当前对话工作区运行命令',
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
  /** ▾ 自己：既当菜单的锚点，也当「再点一次关掉」的豁免元素 */
  const caretRef = useRef<HTMLButtonElement | null>(null)
  const [shellItems, setShellItems] = useState<ContextMenuItem[]>([])

  /**
   * 点整行：直接开。终端**不带** shell —— 宿主按「上次用的那种 → 后端默认」开
   *（`resolveShellChoice`），与 `Ctrl + \`` 同一条路。
   */
  function openEntry(entry: Entry): void {
    onPick(entry.kind)
  }

  /**
   * 点标题后面的 ▾：开 / 关类型菜单。
   *
   * 四个细节：
   * - 锚点（`rect`）必须在 `await` **之前**取：`getBoundingClientRect` 现在读的是 ▾ 自己，
   *   弹出来的菜单贴着 ▾ 而不是贴着整行（菜单由 `ContextMenu` 钳进视口）；
   * - 菜单开着时再点一次 ▾ = 关掉（`ContextMenu` 的 `anchorElement` 让「点锚点」不算点在外面，
   *   否则 mousedown 先关、click 又开，看着像点不动）；
   * - 列表取不到（非桌面环境 / 命令失败）或**一个能用的都没有**，就直接开默认终端 ——
   *   不能让人点了没反应，也不能弹出一片全灰的菜单；
   * - 菜单项与位置在同一次更新里落地（React 18 会自动合并），不会先闪一个空菜单。
   */
  function toggleShellMenu(): void {
    if (shellMenu.state) {
      shellMenu.close()
      return
    }
    const anchor = caretRef.current
    if (!anchor || !loadShells) return
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
            ? t('此对话未设置工作区目录。')
            : t(entry.description)
          // 只有终端有「类型」要挑；宿主没接 `loadShells`（非桌面 / 老调用点）时没有菜单可弹，
          // 就把 ▾ 也省了 —— 不摆一颗点了没东西的控件（整行照旧直开默认那种）
          const withShellMenu =
            entry.kind === 'terminal' && !!loadShells && !command.pending

          return (
            <div
              key={entry.kind}
              className={`panel-guide-entry${disabled ? ' is-disabled' : ''}`}
              data-guide-entry={entry.kind}>
              {/* 主操作：铺满整行的那层真按钮（点它 = 开默认那种 / 打开对应页面） */}
              <button
                type="button"
                className="panel-guide-entry-hit"
                disabled={disabled}
                aria-label={t(entry.label)}
                title={command.pending ? t('即将支持') : undefined}
                onClick={() => {
                  if (disabled) return
                  openEntry(entry)
                }}
              />
              {/* 看得见的那一层：文字与键帽都不抢指针（点击穿到上面那层按钮），
                  唯一的例外是终端标题后面那颗 ▾ */}
              <div className="panel-guide-entry-body">
                <span className="panel-guide-entry-icon">
                  <Icon />
                </span>
                <span className="panel-guide-entry-text">
                  <span className="panel-guide-entry-title-row">
                    <span className="panel-guide-entry-title">{t(entry.label)}</span>
                    {withShellMenu && (
                      <button
                        type="button"
                        ref={caretRef}
                        className="panel-guide-entry-caret"
                        title={t('选择终端类型')}
                        aria-label={t('选择终端类型')}
                        aria-haspopup="menu"
                        aria-expanded={shellMenu.state !== null}
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return
                          toggleShellMenu()
                        }}>
                        <DropDownSvg />
                      </button>
                    )}
                  </span>
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
              </div>
            </div>
          )
        })}
      </div>

      {/* 终端类型菜单（没装的灰显）：位置贴着 ▾，点外面 / Esc / 再点一次 ▾ 关掉 */}
      {shellMenu.state && (
        <ContextMenu
          position={shellMenu.state.position}
          items={shellItems}
          // 认出「再点一次 ▾」：不算点在外面（否则 mousedown 先关、click 又开，看着像点不动）
          anchorElement={caretRef.current}
          onClose={shellMenu.close}
        />
      )}
    </div>
  )
}
