/**
 * 3D 预览的**异常日志**（纯数据：不 import React、不 import three、不碰磁盘）。
 *
 * 为什么要有它：模型预览的失败大多是**静默**的 —— 贴图 404 会被 `LoadingManager.onError`
 * 吞掉、失效贴图槽会被 `dropUnloadedTextures` 摘掉、`.gltf` 引外部文件在解析前就被拒。
 * 用户看到的结果只有「纯色」或「一片空白」，控制台里那几行也没人去看。所以每一条可能出错的
 * 分支都往这里投一条，面板用工具栏的日志按钮 + 数量徽标把它显示出来。
 *
 * 四条口径：
 * 1. **标题集中在 `DIAGNOSTIC_TITLES`**（中文即 i18n key），渲染时才 `t()` / `tpl()`。
 *    集中不是为了好看：用例要能把它**逐条对照 `en-US.json`** —— 新增一条忘了翻译，
 *    英文环境里就会冒出中文（新增诊断的成本必须只有「加一行 + 加一条译文」）。
 * 2. **`detail` 不翻译**：文件名、路径、库抛的原文 —— 翻译它们只会让排查更费劲。
 * 3. **同一条只累加 `count`**：贴图是异步结算的（`watchTextures` 可能结算多批），同一句警告
 *    不该把列表刷满；上限 `MAX_DIAGNOSTICS` 条，超了丢最旧的（新问题比旧问题重要）。
 * 4. **只上报「用户看得懂且能行动」的**：定位贴图时大量候选路径本来就会落空，那不是异常。
 *
 * 本文件不依赖任何运行时：用例在 node 环境里直接跑。
 */

/** 只分两级：徽标要的是「有多少东西不对劲」，info 会把信号稀释掉 */
export type DiagnosticLevel = 'error' | 'warning'

/**
 * 全部诊断标题（中文即 i18n key）。
 *
 * ⚠️ 新增一条必须同时补 `en-US.json` —— `workspace-file-model-diagnostics.test.ts` 会逐条查。
 */
export const DIAGNOSTIC_TITLES = {
  /** WebGL 上下文都建不出来（老驱动 / 远程桌面） */
  webgl: '无法创建 3D 预览',
  /** 场景 / 加载器的 chunk 没拉下来（dev server 重启、dist 被换掉） */
  'module-load': '3D 预览模块加载失败',
  parse: '模型解析失败',
  'external-resources': '模型引用了外部资源',
  unsupported: '暂不支持该模型格式',
  'texture-missing': '贴图缺失',
  'texture-scan': '贴图扫描失败（这个模型只能显示纯色）',
  'texture-too-large': '贴图过大，已跳过',
  'texture-budget': '贴图总大小超出预算，剩余的已跳过',
  'texture-dropped': '$__n__ 个贴图加载失败，已从材质移除',
  'empty-bounds': '模型没有可显示的几何',
  'empty-mesh': '模型里没有可渲染的网格',
  'context-lost': '显卡上下文丢失，预览已停止（重新打开这个模型）',
  screenshot: '截图失败，预览没有可见区域',
} as const

/** 上报内容（生产者填的原始形状） */
export interface DiagnosticInput {
  level: DiagnosticLevel
  /** 机器可读的分类（去重键的一部分，也是用例的断言点）：`texture-missing` / `parse` … */
  code: string
  /** 一句话（`DIAGNOSTIC_TITLES` 里的一条，渲染时翻译） */
  title: string
  /** `title` 里 `$__x__` 占位符的值（走 `tpl`） */
  params?: Readonly<Record<string, string | number>>
  /** 文件名 / 路径 / 库抛的原文（不翻译） */
  detail?: string
}

/** 上报函数：面板把它接进 React state；不给就是「只算不记」（用例 / 旧调用方） */
export type DiagnosticReport = (input: DiagnosticInput) => void

/** 日志里的一条 */
export interface DiagnosticEntry extends DiagnosticInput {
  /** 面板里的 React key（同一份日志里唯一） */
  id: number
  /** 同一条被上报了几次（异步贴图会反复结算） */
  count: number
  /** 首次出现的时间戳（ms） */
  time: number
}

/** 列表上限：再多用户也不会看，反而把真正的原因挤下去 */
export const MAX_DIAGNOSTICS = 40

/** 去重键：级别 + 分类 + 标题 + 占位符值 + 细节全同才算同一条 */
function keyOf(input: DiagnosticInput): string {
  const params = input.params ? JSON.stringify(input.params) : ''
  return [input.level, input.code, input.title, params, input.detail ?? ''].join('|')
}

/**
 * 追加一条：已存在同一条（键相同）时只把 `count` 加一，否则追加到末尾。
 * 超过上限时丢**最旧**的几条。
 */
export function appendDiagnostic(
  prev: readonly DiagnosticEntry[],
  input: DiagnosticInput,
  now = Date.now(),
): DiagnosticEntry[] {
  const key = keyOf(input)
  const index = prev.findIndex((entry) => keyOf(entry) === key)
  if (index >= 0) {
    const next = prev.slice()
    next[index] = { ...next[index], count: next[index].count + 1 }
    return next
  }
  let id = 1
  for (const entry of prev) id = Math.max(id, entry.id + 1)
  const next = [...prev, { ...input, id, count: 1, time: now }]
  return next.length > MAX_DIAGNOSTICS ? next.slice(next.length - MAX_DIAGNOSTICS) : next
}

export interface DiagnosticCounts {
  errors: number
  warnings: number
  total: number
}

/** 徽标与弹窗头部的数字（按**条目**数，不按 `count` 累加：一条反复出现仍是一件事） */
export function countDiagnostics(entries: readonly DiagnosticEntry[]): DiagnosticCounts {
  let errors = 0
  for (const entry of entries) if (entry.level === 'error') errors += 1
  return { errors, warnings: entries.length - errors, total: entries.length }
}

/** 字节数 → 「12.4 MB」（`detail` 不翻译，单位用国际写法） */
function megabytesOf(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 贴图统计 → 「贴图缺失」诊断（`found >= total` 或压根没有外部贴图时返回 null）。
 *
 * `missing` 是 loader 真要过、但磁盘上没有的名字 —— 只报「2 / 3」用户没法去补文件，
 * 名字才是可行动的（前面最多列 6 个，再多用 `+N` 收尾）。
 */
export function textureDiagnostic(
  found: number,
  total: number,
  missing: readonly string[] = [],
): DiagnosticInput | null {
  if (total <= 0 || found >= total) return null
  const names = missing.slice(0, 6).join(', ')
  const more = missing.length > 6 ? ` … +${missing.length - 6}` : ''
  return {
    level: 'warning',
    code: 'texture-missing',
    title: DIAGNOSTIC_TITLES['texture-missing'],
    detail: `${found} / ${total}${names ? ` · ${names}${more}` : ''}`,
  }
}

/** 失效贴图槽被摘掉 → 一条警告（`dropped` 为 0 时返回 null：没动过就别记） */
export function droppedTextureDiagnostic(dropped: number): DiagnosticInput | null {
  if (dropped <= 0) return null
  return {
    level: 'warning',
    code: 'texture-dropped',
    title: DIAGNOSTIC_TITLES['texture-dropped'],
    params: { n: dropped },
  }
}

/** 单张贴图超过 `MAX_TEXTURE_BYTES` 被跳过（`name` 只给文件名，路径对排查没有额外价值） */
export function tooLargeTextureDiagnostic(name: string, bytes: number): DiagnosticInput {
  return {
    level: 'warning',
    code: 'texture-too-large',
    title: DIAGNOSTIC_TITLES['texture-too-large'],
    detail: `${name} · ${megabytesOf(bytes)}`,
  }
}

/** 贴图总量超出预算、后面的不再读（只报第一条越界的） */
export function budgetTextureDiagnostic(name: string, bytes: number): DiagnosticInput {
  return {
    level: 'warning',
    code: 'texture-budget',
    title: DIAGNOSTIC_TITLES['texture-budget'],
    detail: `${name} · ${megabytesOf(bytes)}`,
  }
}

/**
 * 解析失败 → 一条 error。`code` 是 `ModelLoadError.code`（只有 `external-resources` /
 * `unsupported` 两种有专门文案，其余一律「模型解析失败」，库的原文进 `detail`）。
 */
export function loadFailureDiagnostic(code: string | undefined, text: string): DiagnosticInput {
  const known =
    code === 'external-resources' || code === 'unsupported' ? code : undefined
  return {
    level: 'error',
    code: `load:${known ?? 'parse'}`,
    title: DIAGNOSTIC_TITLES[known ?? 'parse'],
    detail: text,
  }
}

/** `HH:MM:SS`：日志行的时间戳不跟随 locale（同一屏里的行要能互相对齐） */
export function clockOf(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
