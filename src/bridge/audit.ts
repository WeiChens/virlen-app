/**
 * 审计日志 —— 手机控制的**操作留痕**（「谁在什么时候批了什么」，见 docs/phone-control-bridge.md §16.1/§16.3）。
 *
 * 内存环形缓冲是权威读取面（设置页「操作记录」同步读，无 IO）；落盘是旁路（persist 回调，
 * fire-and-forget，写盘失败不影响功能，只影响事后可回溯）。Tauri 下由 Rust 追加 JSONL。
 *
 * ⚠️ 为什么 M4 必须落盘：审批取「宽松档」，若审计只在内存则重启即失 —— 高风险操作将**无痕**（§16.3-1）。
 */
import type { ApprovalTier } from 'virlen-remote'

/** 审计条目的类别：普通 RPC / 审批决策。 */
export type AuditKind = 'rpc' | 'approval'

export interface AuditEntry {
  at: number
  /** RPC 方法名（如 `host.session.send`）。 */
  method: string
  kind: AuditKind
  /** 是否被 ACL 放行（`false` = 被拒，需要在设置页显式区分展示）。 */
  allowed: boolean
  sessionId?: string
  /** 附加说明（拒绝原因 / 令牌来源等）。 */
  detail?: string
  /** 审批相关：分级（`low` / `high`）。 */
  tier?: ApprovalTier
  /** 审批相关：决策。 */
  decision?: 'allow' | 'deny' | 'shelve'
  /** 审批相关：由谁作出（`mobile` = 手机，`host` = 电脑）。 */
  by?: 'host' | 'mobile'
  /** 审批相关：交互 id（可与电脑侧日志对齐）。 */
  interactionId?: string
  /** 审批相关：命令 / 正文的**截断预览**（不落全文，避免审计文件被大正文撑爆）。 */
  commandPreview?: string
}

const DEFAULT_MAX_ENTRIES = 500
/** 命令预览截断长度。 */
export const AUDIT_PREVIEW_LEN = 200

export type AuditPersist = (entry: AuditEntry) => void

export class AuditLog {
  private entries: AuditEntry[] = []

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly persist?: AuditPersist,
  ) {}

  record(entry: Omit<AuditEntry, 'at' | 'kind'> & { at?: number; kind?: AuditKind }): AuditEntry {
    const full: AuditEntry = {
      at: entry.at ?? Date.now(),
      kind: entry.kind ?? 'rpc',
      ...entry,
    }
    this.entries.push(full)
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
    }
    try {
      this.persist?.(full)
    } catch {
      /* 落盘是旁路：失败不影响功能 */
    }
    return full
  }

  /** 倒序（最新在前）—— 设置页直接渲染。 */
  list(): AuditEntry[] {
    return [...this.entries].reverse()
  }

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }
}

/** 生成命令预览（统一截断规则，避免各处各写一份）。 */
export function previewOf(text: string | undefined | null): string | undefined {
  if (!text) return undefined
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return oneLine.length > AUDIT_PREVIEW_LEN ? `${oneLine.slice(0, AUDIT_PREVIEW_LEN)}…` : oneLine
}
