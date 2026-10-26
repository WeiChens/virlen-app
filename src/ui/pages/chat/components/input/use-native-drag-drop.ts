/**
 * 输入框的原生拖放落点（能拿到真实路径）
 *
 * 事件来自 Rust 的 `drag_drop` 模块（自定义 OLE 拖放目标，`dragDropEnabled: true`，§11.8）；
 * **监听只有一份**，住在 `@/ui/hooks/useNativeFileDrop`（宿主 `chat-view` 挂的），本文件只负责
 * 把「输入框这块矩形」登记成一个落点 —— 右侧栏也登记了一个，各自 listen 会让一次拖放处理两遍。
 * 「落在哪儿都不接」的提示同样搬去了那儿（现在落点不止一个）。
 *
 * 仅在 Tauri 环境生效；浏览器调试模式走页面的 HTML5 drop（拿不到路径）。
 */
import { useNativeDropTarget } from '@/ui/hooks/useNativeFileDrop'

export function useNativeDragDrop({
  acceptPaths,
  wrapperRef,
  setIsDragOver,
}: {
  acceptPaths: (paths: string[]) => Promise<void>
  wrapperRef: { current: HTMLDivElement | null }
  setIsDragOver: (v: boolean) => void
}) {
  useNativeDropTarget({
    element: () => wrapperRef.current,
    onDrop: (paths) => void acceptPaths(paths),
    onHover: setIsDragOver,
  })
}
