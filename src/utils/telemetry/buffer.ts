/**
 * telemetry/buffer — 本地采集缓冲（§8）
 *
 * 内存队列 + localStorage 落盘；上限 5000 条 / 4.5MB，超限丢最旧。
 * 落盘使用节流，避免高频事件频繁写盘；localStorage 写入失败（配额）时降级为纯内存。
 */
import type { TelemetryEvent } from './types'

const STORAGE_KEY = 'virlen_telemetry_buffer'
/** 条数上限 */
const MAX_EVENTS = 5000
/** 字节上限（略低于 localStorage 5MB，留出余量） */
const MAX_BYTES = 4.5 * 1024 * 1024
/** 落盘节流间隔 */
const PERSIST_DELAY = 500

/** 单条事件估算字节数 */
function estimateEventBytes(e: TelemetryEvent): number {
  try {
    return JSON.stringify(e).length
  } catch {
    return 256
  }
}

class TelemetryBuffer {
  private events: TelemetryEvent[] = []
  private bytes = 0
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistenceEnabled = true

  /** 从 localStorage 载入历史缓冲 */
  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        this.events = arr
        this.bytes = arr.reduce(
          (sum: number, e: TelemetryEvent) => sum + estimateEventBytes(e),
          0,
        )
        // 载入后若超限，裁剪最旧
        this.evictIfNeeded()
      }
    } catch {
      this.events = []
      this.bytes = 0
    }
  }

  /** 追加事件（超限丢最旧） */
  push(e: TelemetryEvent): void {
    this.events.push(e)
    this.bytes += estimateEventBytes(e)
    this.evictIfNeeded()
    this.schedulePersist()
  }

  private evictIfNeeded(): void {
    while (
      this.events.length > MAX_EVENTS ||
      (this.bytes > MAX_BYTES && this.events.length > 1)
    ) {
      const removed = this.events.shift()
      if (!removed) break
      this.bytes -= estimateEventBytes(removed)
    }
    if (this.bytes < 0) {
      this.bytes = this.events.reduce(
        (sum, e) => sum + estimateEventBytes(e),
        0,
      )
    }
  }

  private schedulePersist(): void {
    if (!this.persistenceEnabled) return
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.writeNow()
    }, PERSIST_DELAY)
  }

  private writeNow(): void {
    if (!this.persistenceEnabled) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events))
    } catch {
      // 配额超限：降级为纯内存，避免拖垮主流程
      this.persistenceEnabled = false
    }
  }

  /** 立即落盘（卸载 / 清空 / 上传前调用） */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.writeNow()
  }

  getAll(): TelemetryEvent[] {
    return this.events
  }

  count(): number {
    return this.events.length
  }

  sizeBytes(): number {
    return this.bytes
  }

  /** 清空缓冲并落盘 */
  clear(): void {
    this.events = []
    this.bytes = 0
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.writeNow()
  }
}

export const telemetryBuffer = new TelemetryBuffer()
