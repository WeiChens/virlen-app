/**
 * usage-ledger — 用量账本的基础设施实现（Tauri → Rust SQLite）
 *
 * 领域侧只认识 `domain/usage` 的端口；这里把流水经 `cmd_append_usage`
 * 写到 Rust 侧的 `usage_ledger` 表（与 Rust 引擎写的同一张表）。
 *
 * 非 Tauri 环境（vitest / 浏览器 dev）invoke 会抛错 —— 全部吞掉：
 * 记账是旁路能力，绝不能因为它失败而影响聊天。
 */
import { invoke } from '@tauri-apps/api/core'
import { trackError } from '@/utils/telemetry'
import type { UsageLedgerPort, UsageLedgerRecord } from '@/domain/usage'

class TauriUsageLedger implements UsageLedgerPort {
  append(records: UsageLedgerRecord[]): void {
    if (!records.length) return
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return
    }
    try {
      // fire-and-forget：不 await，落库不阻塞 LLM 主流程
      void invoke('cmd_append_usage', { entries: records }).catch((e) => {
        // 记账失败不影响业务：只留下诊断埋点（不 console.error 刷屏）
        trackError('usage.append.fail', e)
      })
    } catch {
      // invoke 同步抛出（非 Tauri 环境）→ 静默忽略
    }
  }
}

export const tauriUsageLedger = new TauriUsageLedger()
