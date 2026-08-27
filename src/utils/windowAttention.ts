/**
 * window-attention — 窗口注意力提示
 *
 * 用于在 AI 回复完成、但应用窗口未处于激活（聚焦）状态时，
 * 通过 Tauri 原生 API 请求用户注意力（任务栏图标闪烁）。
 *
 * 注意：该功能依赖 Tauri 运行环境；非 Tauri 环境（如浏览器 / 测试）会静默失败。
 */
import {
  getCurrentWindow,
  UserAttentionType,
} from '@tauri-apps/api/window'

/**
 * 当窗口未聚焦时请求用户注意力。
 *
 * - Critical：任务栏图标持续闪烁，直到用户聚焦窗口
 * - Informational：仅闪烁一次（更轻量）
 *
 * @param type 注意力请求类型
 * @returns 是否成功触发（false 表示窗口已聚焦、调用失败或非 Tauri 环境）
 */
export async function requestAttentionIfUnfocused(
  type: UserAttentionType = UserAttentionType.Critical,
): Promise<boolean> {
  try {
    const appWindow = getCurrentWindow()
    const focused = await appWindow.isFocused()
    if (focused) return false
    await appWindow.requestUserAttention(type)
    return true
  } catch (e) {
    // 非 Tauri 环境 / 权限不足时静默失败，不影响主流程
    console.warn('[window-attention] requestUserAttention failed:', e)
    return false
  }
}
