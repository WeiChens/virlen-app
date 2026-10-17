/**
 * 埋点 SDK 统一入口。
 * 默认关；开启后 track() 只写本地缓冲，不上传。导出 zip 与采集都经密钥打码。
 * 业务层只调 track / trackError / startSpan / newTraceId / newSpanId。
 */
import { makeObservable, observable, runInAction } from 'mobx'
import { v4 } from '@/utils/uuid'
import { telemetryBuffer } from './buffer'
import { redactDeep, redactString } from './redact'
import {
  buildCommon,
  initTelemetryCommon,
  setTelemetryRuntimeContextProvider,
} from './common'
import {
  buildBundlePayload,
  defaultExportName,
  saveZip,
} from './transport'
import { buildBundleDoc, BUNDLE_DOC_NAME } from './export-doc'
import type {
  TelemetryEngineKind,
  TelemetryEvent,
  TelemetryErrorInfo,
  TelemetryRuntimeContext,
  TrackOptions,
} from './types'
import { SDK_VERSION } from './types'

export { SDK_VERSION } from './types'
export type {
  TelemetryEvent,
  TrackOptions,
  TelemetryRuntimeContext,
} from './types'
export {
  redactString,
  redactDeep,
  redactPath,
  urlHost,
  hashText,
  truncateText,
  REDACTED,
  isSensitiveKey,
} from './redact'
export { SDK_VERSION as TELEMETRY_SDK_VERSION }
export { buildBundleDoc, BUNDLE_DOC_NAME } from './export-doc'

// 常量

/** 构建期彻底关闭：VITE_TELEMETRY=off */
const BUILD_DISABLED: boolean =
  (import.meta as any)?.env?.VITE_TELEMETRY === 'off'

/** 高频性能事件采样率 */
export const PERF_SAMPLE_RATE = 0.1

/** 本地缓冲条数上限（与 buffer 一致，用于提示） */
export const BUFFER_MAX_EVENTS = 5000

// 开关与状态

/** 开关读取器（由 UI 层注入） */
let enabledProvider: (() => boolean) | null = null

/** 可观测状态（设置页绑定）：已采集条数 */
class TelemetryStoreState {
  bufferedCount = 0
  constructor() {
    makeObservable(this, {
      bufferedCount: observable,
    })
  }
}
export const telemetryState = new TelemetryStoreState()

// 标识与序号

const DEVICE_ID_KEY = 'virlen_telemetry_device_id'
const SEQ_KEY = 'virlen_telemetry_seq'

function randomBase36(len: number): string {
  let s = ''
  while (s.length < len) {
    s += Math.random().toString(36).slice(2)
  }
  return s.slice(0, len)
}

/** 匿名设备 ID（首次生成后持久化，非硬件指纹） */
function resolveDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id = 'd-' + randomBase36(12)
      localStorage.setItem(DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    return 'd-' + randomBase36(12)
  }
}

/** 本次 App 启动会话 ID（重启变化） */
const appRunId = 'r-' + v4()

const deviceId = resolveDeviceId()

/** 本机单调递增序号（持久化，用于检测丢包 / 乱序） */
let seq = (() => {
  try {
    return Number(localStorage.getItem(SEQ_KEY)) || 0
  } catch {
    return 0
  }
})()

function nextSeq(): number {
  seq += 1
  try {
    localStorage.setItem(SEQ_KEY, String(seq))
  } catch {
    // ignore
  }
  return seq
}

// ID 生成

/** 生成链路追踪 ID */
export function newTraceId(): string {
  return 't-' + randomBase36(8)
}

/** 生成跨度 ID */
export function newSpanId(): string {
  return 's-' + randomBase36(8)
}

// 会话级链路上下文：chat-service 发送时登记，引擎 / 工具执行读取，避免反向依赖。

const sessionTraces = new Map<string, string>()

/** 登记会话当前链路 ID */
export function setSessionTrace(sessionId: string, traceId: string): void {
  sessionTraces.set(sessionId, traceId)
}

/** 读取会话当前链路 ID */
export function getSessionTrace(sessionId: string): string | undefined {
  return sessionTraces.get(sessionId)
}

/** 清除会话链路 ID */
export function clearSessionTrace(sessionId: string): void {
  sessionTraces.delete(sessionId)
}

// 错误信息抽取

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 从任意错误对象抽取 message / stack（并打码） */
export function toErrorInfo(error: unknown): TelemetryErrorInfo {
  if (error == null) return { message: 'unknown error' }
  if (typeof error === 'string') return { message: redactString(error) }
  if (error instanceof Error) {
    return {
      message: redactString(error.message || String(error)),
      stack: error.stack ? redactString(error.stack) : undefined,
    }
  }
  if (typeof error === 'object') {
    const e = error as any
    const message = e.message != null ? String(e.message) : safeStringify(error)
    return {
      message: redactString(message),
      stack: e.stack ? redactString(String(e.stack)) : undefined,
    }
  }
  return { message: redactString(String(error)) }
}

// 核心：track

/** 开关当前是否开启 */
function isEnabled(): boolean {
  if (BUILD_DISABLED) return false
  try {
    return !!enabledProvider?.()
  } catch {
    return false
  }
}

/** 是否处于采集阻断状态（构建期关闭） */
export function isTelemetryBuildDisabled(): boolean {
  return BUILD_DISABLED
}

/**
 * 开关当前是否开启（供高频路径提前返回）：流式帧 / ICE 信令这类节点必须先问再构造载荷。
 */
export function isTelemetryEnabled(): boolean {
  return isEnabled()
}

/**
 * 解析事件级链路字段（顶层）。多数调用方把 trace_id / span_id 放在 props 里，这里统一上提，
 * 保证任何事件都带顶层链路字段；props 里的原值保留以兼容既有消费方。
 */
export function resolveLinkage(
  props: Record<string, any> | undefined,
  opts?: { traceId?: string; spanId?: string },
): { traceId?: string; spanId?: string } {
  const p = props || {}
  return {
    traceId:
      opts?.traceId ?? (typeof p.trace_id === 'string' ? p.trace_id : undefined),
    spanId:
      opts?.spanId ?? (typeof p.span_id === 'string' ? p.span_id : undefined),
  }
}

function buildEvent(
  eventName: string,
  props: Record<string, any> | undefined,
  opts: TrackOptions | undefined,
): TelemetryEvent {
  const p = props || {}
  const { traceId, spanId } = resolveLinkage(p, opts)
  return {
    event_name: eventName,
    event_id: v4(),
    event_time: opts?.time ?? Date.now(),
    device_id: deviceId,
    app_run_id: appRunId,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: opts?.parentSpanId,
    seq: nextSeq(),
    sdk_version: SDK_VERSION,
    common: buildCommon(),
    props: redactDeep(p),
    ...(opts?.snapshot && { snapshot: redactDeep(opts.snapshot) }),
  }
}

function pushEvent(event: TelemetryEvent): void {
  telemetryBuffer.push(event)
  runInAction(() => {
    telemetryState.bufferedCount = telemetryBuffer.count()
  })
}

/**
 * 记录一条埋点事件。开关关闭时 no-op（force 例外）；按 sampleRate 采样；自动打码；异常静默。
 */
export function track(
  eventName: string,
  props?: Record<string, any>,
  opts?: TrackOptions,
): void {
  try {
    if (BUILD_DISABLED) return
    const force = opts?.force === true
    if (!force && !isEnabled()) return
    const rate = opts?.sampleRate ?? 1
    if (rate < 1 && Math.random() >= rate) return
    pushEvent(buildEvent(eventName, props, opts))
  } catch {
    // 埋点自身绝不抛错
  }
}

/** 记录一条错误事件（自动抽取 message / stack 并打码） */
export function trackError(
  eventName: string,
  error: unknown,
  extra?: {
    traceId?: string
    spanId?: string
    props?: Record<string, any>
    snapshot?: Record<string, any>
  },
): void {
  const info = toErrorInfo(error)
  track(
    eventName,
    { ...(extra?.props || {}), error: info.message, stack: info.stack },
    {
      traceId: extra?.traceId,
      spanId: extra?.spanId,
      snapshot: extra?.snapshot,
    },
  )
}

/** 高频性能事件便捷方法（自动按 PERF_SAMPLE_RATE 采样） */
export function trackPerf(
  eventName: string,
  props?: Record<string, any>,
  opts?: TrackOptions,
): void {
  track(eventName, props, { ...opts, sampleRate: opts?.sampleRate ?? PERF_SAMPLE_RATE })
}

// 跨度（Span）

export interface TelemetrySpan {
  spanId: string
  /** 结束：记录 {name}.end 并附带 duration_ms */
  end(extra?: Record<string, any>, opts?: TrackOptions): void
}

/** 开始一个跨度：记录 {name}.start，返回可结束的对象 */
export function startSpan(
  name: string,
  props?: Record<string, any>,
  opts?: TrackOptions,
): TelemetrySpan {
  const spanId = opts?.spanId || newSpanId()
  const start = Date.now()
  track(`${name}.start`, props, { ...opts, spanId })
  let ended = false
  return {
    spanId,
    end(extra?: Record<string, any>, endOpts?: TrackOptions) {
      if (ended) return
      ended = true
      track(
        `${name}.end`,
        { ...(props || {}), duration_ms: Math.round(Date.now() - start), ...(extra || {}) },
        { ...opts, ...endOpts, spanId },
      )
    },
  }
}

// 埋点自身事件

/** 记录开关切换（无论开关状态都记录） */
export function recordTelemetryToggle(enabled: boolean): void {
  track(
    'telemetry.toggle',
    { enabled, buffered_count: telemetryBuffer.count() },
    { force: true },
  )
}

// 导出 / 上报 / 清理

const EXPORT_README = [
  'Virlen Telemetry Bundle',
  '-----------------------',
  '本 zip 由 Virlen 客户端「诊断埋点」功能在本地生成，用于排查问题。',
  'telemetry.json 包含：device_id / app_run_id / common 公共字段 / events 事件列表。',
  'SCHEMA.md 为面向 AI 的结构与统计说明（数据结构 + 数据统计），建议配合 telemetry.json 使用。',
  '所有正文与密钥已在采集与导出前经过密钥模式打码（[REDACTED]）。',
].join('\n')

function clearBufferInternal(): void {
  telemetryBuffer.clear()
  runInAction(() => {
    telemetryState.bufferedCount = 0
  })
}

export interface ExportResult {
  count: number
  bytes: number
  path: string
}

/** 导出本地埋点包（zip），不发任何网络请求；取消 / 失败返回 null */
export async function exportTelemetryBundle(opts?: {
  redact?: boolean
}): Promise<ExportResult | null> {
  const events = telemetryBuffer.getAll().slice()
  const count = events.length
  try {
    const JSZip = (await import('jszip')).default
    const payload = buildBundlePayload(
      opts?.redact ? events.map((e) => redactDeep(e)) : events,
      { deviceId, appRunId },
    )
    const zip = new JSZip()
    zip.file('telemetry.json', JSON.stringify(payload, null, 2))
    // 面向 AI 的结构 + 统计说明，便于按需解析 telemetry.json
    zip.file(BUNDLE_DOC_NAME, buildBundleDoc(payload))
    zip.file('README.txt', EXPORT_README)
    const uint8 = await zip.generateAsync({ type: 'uint8array' })
    const path = await saveZip(uint8, defaultExportName())
    if (!path) {
      track(
        'telemetry.export',
        { event_count: count, path: '', status: 'cancel' },
        { force: true },
      )
      return null
    }
    const bytes = uint8.byteLength
    track(
      'telemetry.export',
      { event_count: count, path, status: 'success' },
      { force: true },
    )
    return { count, bytes, path }
  } catch (e) {
    track(
      'telemetry.export',
      { event_count: count, status: 'fail', error: toErrorInfo(e).message },
      { force: true },
    )
    return null
  }
}

/** 清理本地埋点数据，返回被清理的条数 */
export function clearTelemetry(): number {
  const count = telemetryBuffer.count()
  clearBufferInternal()
  track('telemetry.clear', { event_count: count }, { force: true })
  // 清理动作本身不进缓冲（避免清理后又残留 1 条）
  clearBufferInternal()
  return count
}

/** 当前缓冲条数 */
export function getBufferedCount(): number {
  return telemetryBuffer.count()
}

/** 立即落盘（卸载前调用） */
export function flushTelemetry(): void {
  telemetryBuffer.flush()
}

// 安装（应用启动时调用一次）

/**
 * 安装 Rust 侧埋点回传桥（监听 agent:telemetry），把 Rust 事件路由进 track()。仅 Tauri 生效。
 */
export function installRustTelemetryBridge(): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  import('@tauri-apps/api/event')
    .then(({ listen }) => {
      listen('agent:telemetry', (e) => {
        const p = e.payload as {
          event_name?: string
          props?: Record<string, any>
          event_time?: number
        }
        if (!p || !p.event_name) return
        track(p.event_name, p.props || {}, { time: p.event_time })
      }).catch(() => {})
      // 回放历史 panic：Rust setup 阶段 emit 的事件早于监听注册会丢，故就绪后主动拉取落盘
      drainRustPanics()
    })
    .catch(() => {})
}

/** 拉取并回放落盘的历史 panic（仅埋点开启时消费） */
function drainRustPanics(): void {
  if (!isEnabled()) return
  import('@tauri-apps/api/core')
    .then(({ invoke }) =>
      invoke<Array<Record<string, any>>>('telemetry_drain_panics'),
    )
    .then((list) => {
      if (!Array.isArray(list)) return
      for (const props of list) {
        track('rust.panic', props || {})
      }
    })
    .catch(() => {})
}

/**
 * 安装埋点 SDK。
 * @param options.isEnabled 读取开关状态
 * @param options.runtimeContext 读取运行时上下文
 */
export function installTelemetry(options: {
  isEnabled: () => boolean
  runtimeContext?: () => TelemetryRuntimeContext
}): void {
  enabledProvider = options.isEnabled
  if (options.runtimeContext) {
    setTelemetryRuntimeContextProvider(options.runtimeContext)
  }
  telemetryBuffer.load()
  runInAction(() => {
    telemetryState.bufferedCount = telemetryBuffer.count()
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => telemetryBuffer.flush())
  }
  // 安装 Rust 侧埋点回传桥（agent:telemetry → track）
  installRustTelemetryBridge()
  // 异步补全静态公共字段（不阻塞启动）
  initTelemetryCommon().catch(() => {})
}
