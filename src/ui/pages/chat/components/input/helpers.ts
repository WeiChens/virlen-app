/**
 * input 组件的纯辅助函数（无组件状态）
 */

/** 是否在 Tauri 环境（浏览器调试模式下没有原生拖拽事件） */
export function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 原生拖放事件负载（来自 Rust 的 drag_drop 模块）
 * 形状与 Tauri 内置的 DragDropEvent 一致；落点是相对窗口左上角的物理像素。
 */
export type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'leave' }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }

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
