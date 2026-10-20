/**
 * useZoom — 把「设置 → 通用 → 界面缩放」落到 webview 上。
 *
 * 为什么必须走原生：`setZoom` 改的是 webview 的页面缩放（等价浏览器 Ctrl +/-），
 * 尺寸换算、Monaco 的 canvas、fixed 浮层全都跟着一致；CSS 那几条路（`html{zoom}` /
 * `transform: scale`）只改绘制，命中区与 `getBoundingClientRect` 会各算一套（见 domain/zoom）。
 *
 * 启动那一次**不在这里做**，而是 `src/main.ts` 的 init 步骤（渲染前落地）：useEffect 在
 * 首帧之后才跑，靠它先按 100% 画一帧再跳，缩放差得越多越晃眼。本 hook 只管**变更** + 快捷键。
 *
 * ⚠️ 依赖 capability `core:webview:allow-set-webview-zoom`（src-tauri/capabilities/default.json）。
 *    漏了它不会编译失败，而是运行期被 ACL 拒掉 —— 表现是「滑杆动、界面不动」，控制台只有一条
 *    `setZoom` 的 invoke 报错。
 */
import { useEffect } from 'react'
import { reaction } from 'mobx'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { settingsState } from '@/ui/store/settingStore'
import { isTauriAvailable } from '@/services/rust-engine'
import { applyZoomCommand, normalizeZoom, zoomCommandOf } from '@/domain/zoom'

/**
 * 应用缩放（幂等，可重复调用；脏值由 normalizeZoom 兜底）。
 * 非 Tauri（浏览器 dev / vitest）直接返回：那里没有 webview 可以缩放。
 */
export async function applyWebviewZoom(factor: unknown): Promise<void> {
  if (!isTauriAvailable()) return
  try {
    await getCurrentWebviewWindow().setZoom(normalizeZoom(factor))
  } catch (e) {
    // 不抛：缩放是外观项，失败不该把设置页 / 启动流程带崩
    console.warn('[zoom] 设置界面缩放失败：', e)
  }
}

export function useZoom() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const dispose = reaction(
      () => settingsState.value.zoomFactor,
      (factor: number) => void applyWebviewZoom(factor),
    )

    /**
     * 快捷键：Ctrl/Cmd + `=`（或 `+`）放大、`-` 缩小、`0` 回到 100%。
     *
     * 只改**设置**，不直接调 setZoom：滑杆、落库、埋点读的都是同一个 `zoomFactor`，
     * 真值只有一份；上面的 reaction 会把新值落下去。
     *
     * 监听放在 window 的**捕获阶段**并且吃掉事件，两个原因：
     *  ① 焦点在输入框 / Monaco / 终端里也要生效 —— 缩放过大导致按钮跑出视野时，
     *     Ctrl+0 是唯一还够得着的出路；
     *  ② 不让它冒到 xterm：Ctrl+- 落到终端里是 0x1F（即 Ctrl+_），在 readline 里意味着
     *     undo —— 一个控制字符就会被送进 PTY。
     */
    const onKeyDown = (e: KeyboardEvent) => {
      const command = zoomCommandOf(e)
      if (!command) return
      e.preventDefault()
      e.stopPropagation()
      settingsState.setValue(
        'zoomFactor',
        applyZoomCommand(settingsState.value.zoomFactor, command),
      )
    }
    window.addEventListener('keydown', onKeyDown, true)

    return () => {
      dispose()
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}
