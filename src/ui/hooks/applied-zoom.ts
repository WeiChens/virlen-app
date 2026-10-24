/**
 * 「已经落到 webview 上」的界面缩放 —— 与设置里的**期望值**（`settingsState.zoomFactor`）分开。
 *
 * 为什么需要这一层：原生子视图（`browser/use-native-view.ts`）拿 `getBoundingClientRect()`
 * 的 **CSS 像素**去摆位置，而 Tauri 的 `LogicalPosition` / `LogicalSize` 要的是**逻辑像素**
 * （DIP）—— 两者的比值正是界面缩放：`setZoom(1.25)` 之后 1 CSS px 占 1.25 个逻辑 px。
 * 不换算就是「视图比占位小一圈，而且整体往左上收」，缩放越大差得越远（2 倍时只剩 1/4 面积）。
 *
 * 为什么读「已落地」而不是「设置里的期望值」：`setZoom` 是**异步 IPC**，设置值先变、
 * 页面布局（也就是 rect）后变。照期望值换算会拿到「新倍率 × 旧 rect」—— 先撑大一两帧再收回，
 * 拖滑杆时最明显。所以只有 `await setZoom(...)` 成功之后才更新这里。
 *
 * 单一写入方：`ui/hooks/useZoom.ts::applyWebviewZoom`（启动那一次在 `main.ts` 的
 * `step('zoom')`，渲染前落地）。单测要模拟「缩放已落地」时直接调 `setAppliedZoomFactor`，
 * 生产代码别用它 —— 缩放的真值只有设置那一份。
 */
import { DEFAULT_ZOOM, normalizeZoom } from '@/domain/zoom'

let current = DEFAULT_ZOOM

/** 当前生效的界面缩放（还没设置过 = 100%） */
export function appliedZoomFactor(): number {
  return current
}

/** 记录新倍率（脏值经 `normalizeZoom` 兜底；只有 `applyWebviewZoom` 与单测该调它） */
export function setAppliedZoomFactor(value: unknown): void {
  current = normalizeZoom(value)
}
