/**
 * telemetry/types — 埋点 SDK 类型定义
 *
 * 依据 docs/埋点上报数据设计.md（§3 数据分层 / §4 公共字段 / §8 上报机制）。
 * 本模块不依赖任何 UI / domain 代码，保持底层纯净，避免循环依赖。
 */

/** 埋点 SDK 版本 */
export const SDK_VERSION = '1.0.0'

/** 当前引擎标识 */
export type TelemetryEngineKind = 'rust' | 'ts'

/**
 * 运行时上下文（由 UI 层在启动时注入）
 * 用于补齐「需要读取设置」的公共字段，避免 utils → ui 的循环依赖。
 */
export interface TelemetryRuntimeContext {
  engine?: TelemetryEngineKind
  theme?: string
  font_size?: string
  locale?: string
  app_version?: string
  is_dev?: boolean
}

/** 公共字段（§4），每个事件自动携带 */
export interface TelemetryCommonProps {
  app_version: string
  platform: string
  os_version: string
  arch: string
  locale: string
  theme: string
  font_size: string
  engine: TelemetryEngineKind
  window_w: number
  window_h: number
  dpr: number
  is_dev: boolean
}

/** 单条埋点事件（§10 数据结构示例） */
export interface TelemetryEvent {
  event_name: string
  event_id: string
  event_time: number
  device_id: string
  app_run_id: string
  trace_id?: string
  span_id?: string
  parent_span_id?: string
  seq: number
  sdk_version: string
  common: TelemetryCommonProps
  props: Record<string, any>
  snapshot?: Record<string, any>
}

/** track() 可选参数 */
export interface TrackOptions {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  /** 上下文快照（§3），仅错误/关键事件使用 */
  snapshot?: Record<string, any>
  /** 采样率 0~1，默认 1（全采） */
  sampleRate?: number
  /** 事件发生时间覆盖（默认 Date.now()） */
  time?: number
  /** 忽略开关，强制记录到本地（用于 telemetry.* 自身事件） */
  force?: boolean
}

/** 错误信息抽取结果 */
export interface TelemetryErrorInfo {
  message: string
  stack?: string
}

/** 上报批量接口响应（沿用 IApiResponse<T> 约定） */
export interface ITelemetryUploadResponse {
  code: number
  message: string
  data?: unknown
}
