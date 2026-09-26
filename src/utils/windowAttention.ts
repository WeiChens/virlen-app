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
import { invoke } from '@tauri-apps/api/core'
import { track } from '@/utils/telemetry'

/**
 * 窗口是否被隐藏到托盘时，先把它放出来。
 *
 * ⚠️ 必须传 `ensureVisible = true` 的场景：等用户交互（user_choice / 授权确认 / 终端内确认）
 * —— 隐藏窗口里的弹窗用户根本看不到，而 Rust 侧桥接回执（`agent/bridge.rs` 的 oneshot）
 * 没有超时，引擎会永久挂起。
 */
async function ensureWindowVisible(): Promise<void> {
  const appWindow = getCurrentWindow()
  try {
    // 交给 Rust：unminimize + show（+ 刷新托盘 tooltip），前端不重复窗口逻辑
    await invoke('tray_show_window', { focus: false })
  } catch {
    // 命令不可用（旧版本 / 非 Tauri）→ 退化为前端直接 show
    await appWindow.show()
  }
}

/**
 * 当窗口未聚焦时请求用户注意力。
 *
 * - Critical：任务栏图标持续闪烁，直到用户聚焦窗口
 * - Informational：仅闪烁一次（更轻量）
 *
 * @param type 注意力请求类型
 * @param forceActive 为 true 时，窗口未激活则直接强制激活（还原 + 显示 + 聚焦）
 * @param ensureVisible 为 true 时，窗口被隐藏到托盘则先显示出来（等用户交互时必须开启）
 * @returns 是否成功触发（false 表示窗口已聚焦、调用失败或非 Tauri 环境）
 */
export async function requestAttentionIfUnfocused(
  type: UserAttentionType = UserAttentionType.Critical,
  forceActive = false,
  ensureVisible = false,
): Promise<boolean> {
  try {
    const appWindow = getCurrentWindow()
    const focused = await appWindow.isFocused()
    if (focused) return false

    if (ensureVisible && !(await appWindow.isVisible())) {
      await ensureWindowVisible()
    }

    if (forceActive) {
      if (await appWindow.isMinimized()) {
        await appWindow.unminimize()
      }
      if (!(await appWindow.isVisible())) {
        await appWindow.show()
      }
      await appWindow.setFocus()
      track('interaction.window.force_active', { status: 'success' })
      return true
    }

    await appWindow.requestUserAttention(type)
    return true
  } catch (e) {
    // 非 Tauri 环境 / 权限不足时静默失败，不影响主流程
    console.warn('[window-attention] requestUserAttention failed:', e)
    if (forceActive) {
      track('interaction.window.force_active', { status: 'fail' })
    }
    return false
  }
}
