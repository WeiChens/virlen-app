/**
 * 终端类型（shell）的**界面层**：展示名 + 「新建终端」的菜单项（纯函数，方便单测）。
 *
 * 与后端的分工：Rust 只给稳定 id（`powershell` / `cmd` / `pwsh` / `gitbash`）与「装没装」，
 * 展示名与措辞在这里 —— core 里不该出现「命令提示符」这种界面文案。
 *
 * 四条口径：
 * 1. **装了的在前、没装的沉底**：菜单是给人点的，第一项就该能点；
 * 2. **没装的灰显并标「未安装」**，鼠标停在上面能看到「查过哪些目录」（后端给的 `hint`）——
 *    这比「点了才报启动失败」有用得多；
 * 3. **标出「上次使用」**（`Ctrl + \`` 直接开的就是它），没记忆时标后端给的「默认」；
 * 4. 不认识的 id 原样显示（后端多给一种类型时，界面不会假装它是默认那种）。
 */
import type { ReactNode } from 'react'
import { t, tpl } from '@/ui/i18n'
import type { ContextMenuItem } from '@/ui/components/shared/ContextMenu'
import type { UserTerminalShell } from '@/infrastructure/terminal'

/** 类型 id → 展示名（产品名不翻译；只有「命令提示符」需要 en-US 条目） */
const SHELL_LABELS: Record<string, string> = {
  powershell: 'Windows PowerShell',
  cmd: '命令提示符',
  pwsh: 'PowerShell 7',
  gitbash: 'Git Bash',
}

/** 类型 id → 展示名（不认识的 id 原样返回，便于诊断） */
export function shellLabel(id: string): string {
  const label = SHELL_LABELS[id]
  return label ? t(label) : id
}

/** 可用的在前、未安装的沉底（组内保持后端给的顺序，菜单每次都长一样） */
export function orderShells(shells: UserTerminalShell[]): UserTerminalShell[] {
  return [...shells].sort((a, b) => Number(b.available) - Number(a.available))
}

/**
 * 没记忆时该用哪一种：后端标的 `default`，没有就取第一个可用的。
 * 一个可用的都没有 → `undefined`（让后端自己兜底 / 如实报错）。
 */
export function preferredShellId(shells: UserTerminalShell[]): string | undefined {
  return (
    shells.find((s) => s.default && s.available)?.id ??
    shells.find((s) => s.available)?.id
  )
}

/**
 * 这次到底开哪一种：**显式选的 > 上次记的 > 让后端定**（`undefined`）。
 *
 * 抽出来是为了能单测：「`Ctrl + \`` 走的就是这条（第二个参数），菜单走显式那条（第一个参数）」。
 * 空串当「没选」——设置里的 `''` 就是「从没选过」，不能让一个空字符串覆盖掉默认。
 */
export function resolveShellChoice(
  explicit?: string,
  remembered?: string,
): string | undefined {
  const pick = (explicit ?? '').trim() || (remembered ?? '').trim()
  return pick || undefined
}

/**
 * 「新建终端」菜单项。
 *
 * `lastUsed` 是设置里记的上次选择（空 = 从没用过 → 标「默认」）。
 * 未安装的项 `disabled`，label 上挂 `title`（后端给的诊断：查过哪些目录）。
 */
export function shellMenuItems(input: {
  shells: UserTerminalShell[]
  lastUsed?: string
  onPick: (shellId: string) => void
}): ContextMenuItem[] {
  const { shells, lastUsed, onPick } = input
  const fallback = preferredShellId(shells)
  const marked = lastUsed && shells.some((s) => s.id === lastUsed) ? lastUsed : fallback

  return orderShells(shells).map((shell) => {
    const name = shellLabel(shell.id)
    let label: ReactNode = name
    if (!shell.available) {
      label = <span title={shell.hint ?? undefined}>{tpl('$__name__（未安装）', { name })}</span>
    } else if (shell.id === marked) {
      label = lastUsed
        ? tpl('$__name__（上次使用）', { name })
        : tpl('$__name__（默认）', { name })
    }
    return {
      key: shell.id,
      label,
      disabled: !shell.available,
      onClick: () => onPick(shell.id),
    }
  })
}
