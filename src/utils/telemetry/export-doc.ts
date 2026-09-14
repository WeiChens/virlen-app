/**
 * telemetry/export-doc — 导出包内的「AI 解读文档」（SCHEMA.md）
 *
 * 目的（§8）：导出 zip 时，除 `telemetry.json` 外再附一份面向 AI / 程序的结构与统计
 * 说明，让消费者**先读文档、再按需只取相关事件**，避免一次性把全部事件读入上下文。
 *
 * 本模块是纯函数、零副作用、不 import UI / domain，便于单测。
 */
import type { TelemetryBundle } from './transport'
import type { TelemetryEvent } from './types'

/** 文档在 zip 内的文件名 */
export const BUNDLE_DOC_NAME = 'SCHEMA.md'

/** 事件名模块前缀（稳定说明，便于 AI 归类；不随事件增删漂移） */
const MODULE_PREFIXES: Array<[string, string]> = [
  ['app.', 'App 生命周期（启动/就绪/退出/初始化步骤）'],
  ['env.', '环境与设备（版本、权限、工具链）'],
  ['device.', '设备信息'],
  ['session.', '会话管理（创建/加载/切换/删除/修复）'],
  ['chat.', '消息与对话（发送、流式、暂停恢复、压缩）'],
  ['engine.', 'Agent 引擎（发送、轮次、迭代、风暴保护、结束）'],
  ['tool.', '工具调用（开始/结束/超时/取消、沙盒、审批、路径）'],
  ['provider.', 'Provider / 网络请求（请求、SSE、模型列表）'],
  ['interaction.', '用户交互 / 审批弹窗'],
  ['error.', '错误与异常（**优先关注**）'],
  ['perf.', '性能指标'],
  ['settings.', '设置变更'],
  ['rag.', '检索增强 / 知识库'],
  ['search.', 'Web 搜索'],
  ['web.', '网页抓取'],
  ['skill.', '技能导入 / 广场'],
  ['update.', '更新检查 / 下载 / 策略'],
  ['vision.', '视觉分析'],
  ['editor.', '编辑器'],
  ['i18n.', '语言切换'],
  ['rust.', 'Rust 引擎 / 数据库 / 桥（Rust 侧回传）'],
  ['telemetry.', '埋点自身操作（开关 / 上传 / 导出 / 清理）'],
]

// ==================== 小工具 ====================

/** 转义 Markdown 表格单元格（管道符 / 换行） */
function cell(v: unknown): string {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** 生成 Markdown 表格 */
function table(
  headers: string[],
  rows: Array<Array<string | number | boolean | undefined>>,
): string {
  const head = `| ${headers.map(cell).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** 粗略推断 JSON 值类型 */
function jsType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'arr'
  switch (typeof v) {
    case 'number':
      return Number.isInteger(v) ? 'int' : 'float'
    case 'boolean':
      return 'bool'
    case 'string':
      return 'str'
    case 'object':
      return 'obj'
    default:
      return typeof v
  }
}

/** 时间戳 → 可读字符串（ISO，含本地偏差说明） */
function fmtTime(ms: number): string {
  if (!ms) return '-'
  try {
    return new Date(ms).toISOString()
  } catch {
    return String(ms)
  }
}

/** 人类可读时长 */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m${rs}s`
}

/** 模块前缀说明 */
function moduleOf(eventName: string): string {
  for (const [prefix, desc] of MODULE_PREFIXES) {
    if (eventName.startsWith(prefix)) return desc
  }
  return '其他'
}

// ==================== 统计 ====================

interface KeyStat {
  count: number
  types: Set<string>
}

interface EventStat {
  name: string
  count: number
  firstTime: number
  lastTime: number
  /** props 字段 → 覆盖统计 */
  keys: Map<string, KeyStat>
}

interface BundleStats {
  eventCount: number
  distinctNames: number
  firstTime: number
  lastTime: number
  engines: Set<string>
  platform: string
  traces: number
  errorEvents: number
  failEvents: number
  truncatedEvents: number
  redactedEvents: number
  /** 含 snapshot 的事件数 */
  snapshotEvents: number
  byName: EventStat[]
  /** 按 trace_id 归组的条数（top） */
  byTrace: Array<{ traceId: string; count: number }>
}

/** 检测（已打码的）props 中是否出现打码/截断标记 */
function scanMarks(props: Record<string, any>): {
  redacted: boolean
  truncated: boolean
} {
  let redacted = false
  let truncated = false
  const walk = (v: any, depth: number): void => {
    if (depth > 8 || v == null) return
    if (typeof v === 'string') {
      if (v === '***' || v.includes('[REDACTED]')) redacted = true
      if (v.includes('[truncated')) truncated = true
      return
    }
    if (typeof v === 'object') {
      for (const val of Object.values(v)) walk(val, depth + 1)
    }
  }
  walk(props, 0)
  return { redacted, truncated }
}

function analyze(events: TelemetryEvent[], bundle: TelemetryBundle): BundleStats {
  const stats: BundleStats = {
    eventCount: events.length,
    distinctNames: 0,
    firstTime: 0,
    lastTime: 0,
    engines: new Set<string>(),
    platform: bundle.platform || '',
    traces: 0,
    errorEvents: 0,
    failEvents: 0,
    truncatedEvents: 0,
    redactedEvents: 0,
    snapshotEvents: 0,
    byName: [],
    byTrace: [],
  }

  const byNameMap = new Map<string, EventStat>()
  const traceMap = new Map<string, number>()

  for (const e of events) {
    // 时间窗
    const t = typeof e.event_time === 'number' ? e.event_time : 0
    if (t) {
      if (!stats.firstTime || t < stats.firstTime) stats.firstTime = t
      if (!stats.lastTime || t > stats.lastTime) stats.lastTime = t
    }
    // engine
    if (e.common?.engine) stats.engines.add(String(e.common.engine))
    // trace
    if (e.trace_id) {
      stats.traces += 1
      traceMap.set(e.trace_id, (traceMap.get(e.trace_id) || 0) + 1)
    }
    // 错误/失败
    const name = e.event_name || ''
    if (name.startsWith('error.')) stats.errorEvents += 1
    if (e.props?.status === 'fail') stats.failEvents += 1
    if (e.snapshot) stats.snapshotEvents += 1

    const marks = scanMarks(e.props || {})
    if (marks.redacted) stats.redactedEvents += 1
    if (marks.truncated) stats.truncatedEvents += 1

    // 事件级统计
    let es = byNameMap.get(name)
    if (!es) {
      es = { name, count: 0, firstTime: 0, lastTime: 0, keys: new Map() }
      byNameMap.set(name, es)
    }
    es.count += 1
    if (t) {
      if (!es.firstTime || t < es.firstTime) es.firstTime = t
      if (!es.lastTime || t > es.lastTime) es.lastTime = t
    }
    for (const [k, v] of Object.entries(e.props || {})) {
      let ks = es.keys.get(k)
      if (!ks) {
        ks = { count: 0, types: new Set() }
        es.keys.set(k, ks)
      }
      ks.count += 1
      ks.types.add(jsType(v))
    }
  }

  stats.distinctNames = byNameMap.size
  stats.byName = Array.from(byNameMap.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  )
  stats.byTrace = Array.from(traceMap.entries())
    .map(([traceId, count]) => ({ traceId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  return stats
}

// ==================== 渲染 ====================

/** 构建面向 AI 的导出说明文档（Markdown） */
export function buildBundleDoc(bundle: TelemetryBundle): string {
  const events = Array.isArray(bundle.events) ? bundle.events : []
  const s = analyze(events, bundle)
  const span = s.firstTime && s.lastTime ? s.lastTime - s.firstTime : 0
  const L: string[] = []

  // ---------- 抬头 ----------
  L.push('# Virlen 埋点导出包 — 数据结构说明（供 AI 解析）')
  L.push('')
  L.push(
    '> 本文件由 Virlen 客户端「导出本地」时自动生成，专供 AI / 程序快速理解同包内的 ' +
      '`telemetry.json`。',
  )
  L.push('>')
  L.push(
    `> **一句话摘要**：本次共 **${s.eventCount}** 条事件，覆盖 **${s.distinctNames}** 种事件名，` +
      `时间跨度 **${fmtDuration(span)}**，其中错误事件 **${s.errorEvents}** 条、失败(status=fail) **${s.failEvents}** 条。`,
  )
  L.push('>')
  L.push(
    '> **建议阅读顺序**：① 本文件（结构 + 统计）→ ② 依据 §5「事件分布」与 §6「各事件字段」定位目标 → ' +
      '③ **按需**只读取 `telemetry.json` 中相关事件。**切勿一次性读入全部 events**（体积大、多数无关）。',
  )
  L.push('')

  // ---------- 1. 包内文件 ----------
  L.push('## 1. 包内文件')
  L.push('')
  L.push(
    table(
      ['文件', '内容'],
      [
        ['`telemetry.json`', '全量事件（唯一数据源；结构见 §3/§4）'],
        ['`SCHEMA.md`（本文件）', '数据结构 + 数据统计，专供 AI 定位与解析'],
        ['`README.txt`', '面向人类的简短说明'],
      ],
    ),
  )
  L.push('')

  // ---------- 2. 数据总览 ----------
  L.push('## 2. 数据总览（Statistics）')
  L.push('')
  L.push(
    table(
      ['项', '值', '说明'],
      [
        ['sdk_version', bundle.sdk_version, '埋点 SDK 版本'],
        ['app_version', bundle.app_version || '-', '应用版本'],
        ['platform', bundle.platform || '-', 'windows / macos / linux / android / ios'],
        [
          'engine(s)',
          s.engines.size ? Array.from(s.engines).join(' / ') : '-',
          '本包出现过的引擎（common.engine）'],
        ['device_id', bundle.device_id, '匿名设备 ID（非硬件指纹）'],
        ['app_run_id', bundle.app_run_id, '本次启动会话 ID'],
        ['exported_at', `${fmtTime(bundle.exported_at)}`, '导出时刻（ISO/UTC）'],
        ['event_count', s.eventCount, '事件总数 = events.length'],
        ['distinct_event_names', s.distinctNames, '不同事件名数量'],
        ['first_event_time', fmtTime(s.firstTime), '最早事件时间'],
        ['last_event_time', fmtTime(s.lastTime), '最晚事件时间'],
        ['time_span', fmtDuration(span), '事件时间跨度'],
        ['trace_count', s.traces, '带 trace_id 的事件数（可据此还原链路）'],
        ['error_events', s.errorEvents, '`error.*` 事件数'],
        ['fail_events', s.failEvents, 'props.status === "fail" 的事件数'],
        ['snapshot_events', s.snapshotEvents, '带上下文快照(snapshot)的事件数'],
        ['redacted_events', s.redactedEvents, '含打码标记(***/[REDACTED])的事件数'],
        ['truncated_events', s.truncatedEvents, '含截断标记的事件数'],
      ],
    ),
  )
  L.push('')

  // ---------- 3. telemetry.json 顶层结构 ----------
  L.push('## 3. `telemetry.json` 顶层结构')
  L.push('')
  L.push('```jsonc')
  L.push('{')
  L.push('  "device_id": "d-xxxxxx",       // 匿名设备 ID')
  L.push('  "app_run_id": "r-uuid",         // 本次启动会话 ID')
  L.push('  "app_version": "0.1.2",')
  L.push('  "platform": "windows",')
  L.push('  "sdk_version": "1.0.0",')
  L.push('  "exported_at": 1730000000000,   // 导出时间戳(ms)')
  L.push('  "event_count": 1234,            // = events.length')
  L.push('  "events": [ /* TelemetryEvent[]，见 §4 */ ]')
  L.push('}')
  L.push('```')
  L.push('')
  L.push(
    table(
      ['字段', '类型', '说明'],
      [
        ['device_id', 'str', '匿名设备/安装 ID，首次启动生成并持久化'],
        ['app_run_id', 'str', '本次 App 启动会话 ID，重启变化'],
        ['app_version', 'str', '应用版本'],
        ['platform', 'str', '归一化平台名'],
        ['sdk_version', 'str', '埋点 SDK 版本'],
        ['exported_at', 'int(ms)', '导出时间戳'],
        ['event_count', 'int', '事件总数'],
        ['events', 'arr[obj]', '事件列表，**按发生顺序**排列'],
      ],
    ),
  )
  L.push('')

  // ---------- 4. 事件通用字段 ----------
  L.push('## 4. 事件通用字段（TelemetryEvent）')
  L.push('')
  L.push('每条 `events[]` 元素的固定字段：')
  L.push('')
  L.push(
    table(
      ['字段', '类型', '说明'],
      [
        ['event_name', 'str', '事件名，`{模块}.{对象}.{动作}`（见 §5.1）'],
        ['event_id', 'str(uuid)', '事件唯一 ID（去重）'],
        ['event_time', 'int(ms)', '事件发生时间戳（本机）'],
        ['device_id', 'str', '匿名设备 ID'],
        ['app_run_id', 'str', '启动会话 ID'],
        ['trace_id', 'str?', '链路 ID：同一「发送→完整响应」共享；**还原时间线的关键**'],
        ['span_id', 'str?', '跨度 ID（start/end 配对）'],
        ['parent_span_id', 'str?', '父跨度 ID'],
        ['seq', 'int', '本机单调递增序号（检测丢包/乱序）'],
        ['sdk_version', 'str', '埋点 SDK 版本'],
        ['common', 'obj', '公共字段（见下）'],
        ['props', 'obj', '事件私有字段（各事件不同，见 §6）'],
        ['snapshot', 'obj?', '上下文快照（仅错误/关键事件携带）'],
      ],
    ),
  )
  L.push('')
  L.push('**`common` 公共字段**（每个事件自动携带；排查环境相关问题时优先参考）：')
  L.push('')
  L.push(
    table(
      ['字段', '类型', '说明'],
      [
        ['app_version', 'str', '应用版本'],
        ['platform', 'str', 'windows/macos/linux/android/ios'],
        ['os_version', 'str', '系统版本'],
        ['arch', 'str', 'x86_64 / aarch64 等'],
        ['locale', 'str', '界面语言，如 zh-CN'],
        ['theme', 'str', 'light / dark / system'],
        ['font_size', 'str', 'small / medium / large'],
        ['engine', 'str', '当前引擎 ts / rust'],
        ['window_w', 'int', '逻辑窗口宽'],
        ['window_h', 'int', '逻辑窗口高'],
        ['dpr', 'float', '设备像素比'],
        ['is_dev', 'bool', '是否开发/调试构建'],
      ],
    ),
  )
  L.push('')
  L.push('> 统一 `status` 取值：`success` / `fail` / `cancel` / `timeout` / `pause`。')
  L.push('')

  // ---------- 5. 事件分布 ----------
  L.push('## 5. 事件分布（按 event_name）')
  L.push('')
  if (s.byName.length === 0) {
    L.push('_本包没有事件。_')
  } else {
    L.push(
      table(
        ['event_name', 'count', '占比', '首次', '末次', '模块'],
        s.byName.map((e) => [
          '`' + e.name + '`',
          e.count,
          s.eventCount ? `${((e.count / s.eventCount) * 100).toFixed(1)}%` : '-',
          fmtTime(e.firstTime),
          fmtTime(e.lastTime),
          moduleOf(e.name),
        ]),
      ),
    )
  }
  L.push('')

  // ---------- 5.1 命名模块 ----------
  L.push('### 5.1 事件名前缀含义')
  L.push('')
  L.push(
    table(
      ['前缀', '覆盖范围'],
      MODULE_PREFIXES.map(([p, d]) => ['`' + p + '`', d]),
    ),
  )
  L.push('')

  // ---------- 6. 各事件字段 ----------
  L.push('## 6. 各事件 props 字段（本包实际出现过）')
  L.push('')
  L.push(
    '> 下表为**动态统计**：列出每个 event_name 实际出现过的 props 字段、类型与覆盖率，' +
      '据此即可知道「要读哪个字段」。未出现即代表本包该字段缺省。',
  )
  L.push('')
  if (s.byName.length === 0) {
    L.push('_无。_')
  } else {
    for (const e of s.byName) {
      L.push(`### \`${e.name}\`  （${e.count} 条）`)
      L.push('')
      if (e.keys.size === 0) {
        L.push('_该事件 props 为空。_')
        L.push('')
        continue
      }
      const rows = Array.from(e.keys.entries())
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([k, ks]) => [
          '`' + k + '`',
          Array.from(ks.types).sort().join(' | '),
          `${ks.count}/${e.count}（${((ks.count / e.count) * 100).toFixed(0)}%）`,
        ])
      L.push(table(['字段', '类型', '覆盖率'], rows))
      L.push('')
    }
  }

  // ---------- 7. 错误与失败 ----------
  L.push('## 7. 错误与失败事件')
  L.push('')
  if (s.errorEvents === 0 && s.failEvents === 0) {
    L.push('_本包未发现 `error.*` 事件，也没有 `status=fail` 的事件。_')
  } else {
    const errByName = s.byName.filter(
      (e) => e.name.startsWith('error.') || e.keys.has('error'),
    )
    L.push(
      `共 **${s.errorEvents}** 条 \`error.*\` 事件，**${s.failEvents}** 条 \`status=fail\` 事件。相关事件名：`,
    )
    L.push('')
    L.push(
      table(
        ['event_name', 'count'],
        (errByName.length ? errByName : s.byName).map((e) => [
          '`' + e.name + '`',
          e.count,
        ]),
      ),
    )
    L.push('')
    L.push('> 排查建议：先看 `error.*` 与 `status=fail` 的 `props.error` / `props.stack`，' +
      '再用其 `trace_id` 回溯同链路的前后事件（见 §8）。')
  }
  L.push('')

  // ---------- 8. 链路与时间线 ----------
  L.push('## 8. 链路（trace_id）与时间线')
  L.push('')
  L.push(
    '`trace_id` 把「一次用户发送 → 引擎多轮 → 工具调用 → 流式返回」串成一条链路。' +
      '按 `trace_id` 过滤 `events` 即可还原完整时间线；事件内已按 `seq` 全局有序。',
  )
  L.push('')
  if (s.byTrace.length) {
    L.push(`本包中含事件最多的 trace（top ${s.byTrace.length}）：`)
    L.push('')
    L.push(
      table(
        ['trace_id', '事件数'],
        s.byTrace.map((t) => ['`' + t.traceId + '`', t.count]),
      ),
    )
  } else {
    L.push('_本包事件未携带 `trace_id`。_')
  }
  L.push('')

  // ---------- 9. 脱敏与截断 ----------
  L.push('## 9. 脱敏与截断说明')
  L.push('')
  L.push('- **密钥打码**：所有正文与密钥在**采集与导出时双重**打码。')
  L.push('  - 密钥模式（`sk-...` / `AIza...` / `Bearer ...` / 私钥块）整段 → `[REDACTED]`')
  L.push('  - 敏感字段名（`apiKey` / `*token` / `secret` / `password` / `authorization`）的值 → `***`')
  L.push('  - 系统用户名路径前缀 → `~`（如 `C:\\Users\\alice\\x` → `~\\x`）')
  L.push('- **截断**：超长文本会截断并追加 `…[truncated N chars]`（上限约 16384 字符）。')
  L.push('- 因此看到 `[REDACTED]` / `***` / `[truncated ...]` 属**预期行为**，非数据损坏。')
  L.push('')

  // ---------- 10. 读取方式 ----------
  L.push('## 10. 建议的读取方式')
  L.push('')
  L.push('用 `jq` 精准取数，避免载入全部事件：')
  L.push('')
  L.push('```bash')
  L.push('# 只看事件名与条数')
  L.push("jq '.event_count, (.events | group_by(.event_name) | map({name: .[0].event_name, n: length}))' telemetry.json")
  L.push('')
  L.push('# 只看错误/失败事件')
  L.push("jq '{count: .event_count, value: [.events[] | select(.event_name | startswith(\"error.\")) | {t: .event_time, name: .event_name, props: .props}]}' telemetry.json")
  L.push('')
  L.push('# 按 trace_id 还原一条链路（替换 TRACE_ID）')
  L.push("jq '[.events[] | select(.trace_id == \"TRACE_ID\")] | sort_by(.seq)' telemetry.json")
  L.push('')
  L.push('# 取某个事件名的全部事件')
  L.push("jq '[.events[] | select(.event_name == \"engine.finish\") | .props]' telemetry.json")
  L.push('```')
  L.push('')
  L.push('---')
  L.push('')
  L.push(
    `_由 Virlen 埋点 SDK v${bundle.sdk_version} 于 ${fmtTime(bundle.exported_at)} 自动生成。_`,
  )
  L.push('')

  return L.join('\n')
}
