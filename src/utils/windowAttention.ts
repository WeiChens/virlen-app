/**
 * window-attention — 窗口注意力提示：AI 回复完成、但应用窗口未聚焦时，经 Tauri 原生 API 请求用户注意力
 *（任务栏图标闪烁）。依赖 Tauri 运行环境，非 Tauri（浏览器 / 测试）静默失败。
 */
import {
  getCurrentWindow,
  UserAttentionType,
} from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { track } from '@/utils/telemetry'

/**
 * 窗口被隐藏到托盘时，先把它放出来。
 *
 * ⚠️ 等用户交互（user_choice / 授权确认 / 终端内确认）时必须 ensureVisible —— 隐藏窗口里的弹窗
 * 用户根本看不到，而 Rust 侧桥接回执没有超时，引擎会永久挂起。
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
 * 窗口未聚焦时请求用户注意力（Critical：任务栏持续闪烁直到聚焦；Informational：仅闪一次）。
 *
 * @param forceActive 为 true 时窗口未激活则强制激活（还原 + 显示 + 聚焦）
 * @param ensureVisible 为 true 时窗口被隐藏到托盘则先显示（等用户交互时必须开启）
 * @returns 是否成功触发（false = 已聚焦 / 失败 / 非 Tauri）
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
