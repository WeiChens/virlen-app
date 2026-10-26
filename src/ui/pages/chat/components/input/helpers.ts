/**
 * input 组件的纯辅助函数（无组件状态）
 *
 * 原生拖放的事件形状与监听已不在这一层：监听只有一份，住在 `@/ui/hooks/useNativeFileDrop`
 *（输入框只是其中的一个落点，见 `use-native-drag-drop.ts`）。
 */

/** 像不像一个绝对路径（用于从剪贴板文本里辨认文件路径） */
function looksLikeAbsolutePath(p: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(p) || // Windows 盘符
    p.startsWith('\\\\') || // Windows UNC
    p.startsWith('/') // POSIX / file:// 已归一
  )
}

/**
 * 从剪贴板里捞出文件路径
 *
 * 在资源管理器 / Finder 里「复制文件」后，剪贴板除了文件本体（拿不到路径），
 * 通常还带一份路径文本（text/plain 或 text/uri-list），这里把它解析成路径。
 * 拿不到时返回空数组，由调用方给出提示。
 */
export function extractPathsFromClipboard(dt: DataTransfer): string[] {
  const raw = [dt.getData('text/plain'), dt.getData('text/uri-list')]
    .filter(Boolean)
    .join('\n')

  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    let text = line.trim()
    if (!text || text.startsWith('#')) continue
    if (/^file:\/\//i.test(text)) {
      text = decodeURIComponent(text.replace(/^file:\/\//i, ''))
      // /C:/xxx → C:/xxx（Windows 的 file:/// 形式会多一个前导斜杠）
      if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1)
    }
    if (!looksLikeAbsolutePath(text)) continue
    out.push(text)
  }
  return out
}
