import { useEffect, useRef, useState } from 'react'
import { t } from '@/ui/i18n'
import toolInteractEvent from '@/events/toolInteractEvent'
import type { PendingConfirmInfo } from '@/infrastructure/tools/output-store'
import { requestAttentionIfUnfocused } from '@/utils/windowAttention'
import { settingsState } from '@/ui/store/settingStore'

/**
 * 终端内确认块（Step 2 ①）—— WinkTerm `write_command` 的 **L2 等价物**。
 *
 * 语义（三条必须同时成立）：
 *   1. **AI 不偷偷执行**：用户按 Enter 之前命令一行都不跑；
 *   2. **可改**：用户直接编辑命令正文，执行的必须是改后的版本；
 *   3. **可退**：Esc / Ctrl+C 取消 → Rust 侧返回 `[User cancelled]`。
 *
 * 与运行态的**视觉显著区分**（PITFALL §7 #16）：独立底色 + 「尚未执行」徽标 +
 * 无终端光标 + 明说「Enter 才执行」，避免用户误以为「已经跑过了」。
 *
 * 组件不直接摸 service：只用 `toolInteractEvent` 抛纯 UI 事件，由 tool-service 消费。
 */
export function TerminalConfirmBlock({
  toolCallId,
  title,
  info,
}: {
  toolCallId: string
  title: string
  info: PendingConfirmInfo
}) {
  const [command, setCommand] = useState(info.desc ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    // 终端内确认同样属于「等待用户授权」→ 窗口未激活时闪烁提醒；
    // 隐藏到托盘时必须先显示窗口（否则确认框无人应答 → 引擎挂死）
    void requestAttentionIfUnfocused(
      undefined,
      settingsState.value.forceWindowActive,
      true,
    )
  }, [])

  const submit = () =>
    toolInteractEvent.emit('terminalConfirmSubmit', toolCallId, command)
  const cancel = () =>
    toolInteractEvent.emit('terminalConfirmCancel', toolCallId)

  return (
    <div className="execute-command-wrapper is-pty is-confirm">
      <div className="header">
        <span className="title">{title}</span>
        <span className="terminal-status confirm">{t('等待用户确认')}</span>
      </div>
      <div className="pty-confirm-body">
        <div className="pty-confirm-row">
          <span className="pty-confirm-badge">{t('尚未执行')}</span>
          {info.title && (
            <span className="pty-confirm-risk">{info.title}</span>
          )}
          {info.permName && (
            <code className="pty-confirm-perm">{info.permName}</code>
          )}
        </div>
        <input
          ref={inputRef}
          className="pty-confirm-input"
          value={command}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape' || (e.ctrlKey && e.key === 'c')) {
              e.preventDefault()
              cancel()
            }
          }}
        />
        {info.hint && <div className="pty-confirm-hint">{info.hint}</div>}
        <div className="pty-confirm-actions">
          <button className="tool-cmd-confirm-btn" onClick={submit}>
            {t('执行')}
          </button>
          <button className="terminal-ctl-btn" onClick={cancel}>
            {t('取消')}
          </button>
        </div>
        <div className="pty-hint pty-confirm-tip">
          {t('按 Enter 执行，Esc 取消；可直接编辑')}
        </div>
      </div>
    </div>
  )
}
