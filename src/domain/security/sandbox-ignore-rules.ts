/**
 * sandbox-ignore-rules — 「忽略沙盒命令」规则（领域层，纯匹配逻辑）。
 *
 * 脱壳（`sandbox:"off"`）命令（vitest / vite / node-gyp 等）每次都要走审批，在「安装 / 测试」这类
 * 高频命令上很烦人。本模块提供「命令 → 是否命中忽略规则」纯函数（不依赖 store / UI / i18n）；
 * 命中的命令由 `command_confirm.ts` 在交互层直接放行。
 *
 * 三种 kind：`text` 字面量比较（完全 / 前缀 / 后缀，默认忽略大小写）、`regex` 正则源码（`caseSensitive`
 * 决定是否加 `i`）、`js` 用户自写 JS（参数 `command`，返回真值即命中；写法见 `buildJsFunction`）。
 * 匹配按列表顺序取**第一条命中且已启用**的规则。
 *
 * ⚠️ 安全边界（改这里须连同 `command_confirm.ts` 的拦截条件一起看）：规则只免除脱壳审批，不改变命令
 * 本身的风险审批；`deny` 永远优先；JS 规则编译/运行抛错一律按「未命中」，绝不放行。
 */
import { v4 } from '@/utils/uuid'

/** 规则类型 */
export type SandboxRuleKind = 'text' | 'regex' | 'js'

/** 文本规则的比较方式 */
export type SandboxTextMode = 'exact' | 'prefix' | 'suffix'

/** 一条「忽略沙盒命令」规则 */
export interface SandboxIgnoreRule {
  /** 稳定 id（用于增删改） */
  id: string
  /** 规则名称（用户可读，出现于 UI 与埋点） */
  name: string
  /** 是否启用（禁用后不参与匹配） */
  enabled: boolean
  /** 匹配类型 */
  kind: SandboxRuleKind
  /** `kind === 'text'` 时的比较方式；其他类型忽略 */
  textMode: SandboxTextMode
  /** 匹配内容：text=字面量，regex=正则源码，js=函数体 */
  pattern: string
  /** 是否区分大小写（text / regex 有效；js 由用户自行处理） */
  caseSensitive: boolean
}

/** 规则测试结果（UI「测试」按钮与匹配共用） */
export interface SandboxRuleTestResult {
  matched: boolean
  /** 编译 / 运行错误信息（未命中时才有意义；不参与放行决策） */
  error?: string
}

/**
 * JS 规则的默认函数体（新建规则或切到 `js` 时预填）：带注释的函数声明 + `return false`，
 * 默认不命中（用户没改之前不会静默放行任何命令）。
 */
export const SANDBOX_JS_DEFAULT_PATTERN = [
  'function matchCommand(command) {',
  '  // command = AI 实际要执行的命令（已去掉首尾空白）',
  '  // 返回真值即命中：该命令免除「沙盒脱壳」授权审批',
  '  // 例如：return command.startsWith("pnpm test")',
  '  return false',
  '}',
].join('\n')

/** 各匹配方式的「匹配内容」默认值：切换 kind 时回填，避免把上一种写法带进来（如把正则塞进 JS 规则）。 */
export function defaultSandboxRulePattern(kind: SandboxRuleKind): string {
  return kind === 'js' ? SANDBOX_JS_DEFAULT_PATTERN : ''
}

/**
 * 空列表「一键添加」的常用规则预设（名称即 i18n key）。一律用 `regex`：命令真实形态是
 * 「同族 + 不同参数」（`pnpm install` / `pnpm i` / `npm ci`），字面量前缀匹配撑不住。预设仅是起点。
 */
export interface SandboxRulePreset {
  /** 预设标识（稳定，供测试引用；不是规则 id） */
  key: string
  /** 规则名称（中文即 i18n key） */
  name: string
  kind: SandboxRuleKind
  textMode: SandboxTextMode
  /** 预填的匹配内容 */
  pattern: string
}

export const SANDBOX_RULE_PRESETS: SandboxRulePreset[] = [
  {
    key: 'install',
    name: '安装依赖',
    kind: 'regex',
    textMode: 'exact',
    pattern: '^(npm|pnpm|yarn|bun) (i|install|ci|add)\\b',
  },
  {
    key: 'test',
    name: '运行测试',
    kind: 'regex',
    textMode: 'exact',
    pattern: '^(npm|pnpm|yarn|bun) (run )?(test|vitest)\\b',
  },
  {
    key: 'build',
    name: '构建 / 开发服务',
    kind: 'regex',
    textMode: 'exact',
    pattern: '^(npm|pnpm|yarn|bun) (run )?(build|dev|start)\\b',
  },
  {
    key: 'native',
    name: '原生模块编译',
    kind: 'regex',
    textMode: 'exact',
    pattern: '\\bnode-gyp\\b',
  },
  {
    key: 'pytest',
    name: 'Python 测试',
    kind: 'regex',
    textMode: 'exact',
    pattern: '^(python -m )?pytest\\b',
  },
]

/** 用预设创建一条规则（默认启用，id 自动生成） */
export function createSandboxIgnoreRuleFromPreset(
  preset: SandboxRulePreset,
): SandboxIgnoreRule {
  return createSandboxIgnoreRule({
    name: preset.name,
    kind: preset.kind,
    textMode: preset.textMode,
    pattern: preset.pattern,
  })
}

/** 新建规则的默认值（id 自动生成） */
export function createSandboxIgnoreRule(
  patch: Partial<Omit<SandboxIgnoreRule, 'id'>> = {},
): SandboxIgnoreRule {
  const kind = patch.kind ?? 'text'
  return {
    id: v4(),
    name: params(patch.name, ''),
    enabled: patch.enabled ?? true,
    kind,
    textMode: patch.textMode ?? 'exact',
    pattern: params(patch.pattern, defaultSandboxRulePattern(kind)),
    caseSensitive: patch.caseSensitive ?? false,
  }
}

function params<T>(v: T | undefined, d: T): T {
  return v === undefined ? d : v
}

// ==================== 编译缓存 ====================

/** 正则 / JS 编译缓存（按 pattern + 选项），避免每次命令都重新编译 */
const regexCache = new Map<string, RegExp | Error>()
const jsCache = new Map<string, ((command: string) => unknown) | Error>()
/** 缓存上限：规则集很小，超限整体清空即可（不做 LRU，保持简单） */
const CACHE_LIMIT = 200

function buildRegExp(pattern: string, caseSensitive: boolean): RegExp {
  const key = (caseSensitive ? 's|' : 'i|') + pattern
  const cached = regexCache.get(key)
  if (cached) {
    if (cached instanceof Error) throw cached
    return cached
  }
  try {
    const re = new RegExp(pattern, caseSensitive ? '' : 'i')
    if (regexCache.size > CACHE_LIMIT) regexCache.clear()
    regexCache.set(key, re)
    return re
  } catch (e: any) {
    const err = new Error(e?.message || String(e))
    regexCache.set(key, err)
    throw err
  }
}

/**
 * 去掉开头的空白与注释（`//` / `/* *\/`），只看第一行是什么。
 * 默认模板本身就带注释，若不剥离，`function` 声明会被误判成语句体而静默不命中。
 */
function stripLeadingComments(body: string): string {
  return body.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, '')
}

/** 形如 `const match = (command) => ...` / `const match = function (command) {...}` 的赋值式函数 */
const ASSIGNED_FN =
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\(?[\w$,\s()]*\)?\s*=>)/

/**
 * 编译用户写的 JS 为 `(command) => 真值` 函数。按优先级尝试，尽量让用户「写出来就能命中」：
 * 1. `async` 开头 → 报错（Promise 恒为真值，会放行一切）；2. `function (command) {...}` 声明 → 包成立即
 * 调用；3. `const match = (command) => ...` → 末尾补 `return match(command)`；4. 含 `return` → 原样；
 * 5. 其他 → 先当单表达式，编译不过再回退为原样语句体。
 */
function compileJs(body: string): (command: string) => unknown {
  // 用户自己的规则内容 → 等价于用户自己在应用里写代码（CSP 已允许 eval）
  // eslint-disable-next-line no-new-func
  return new Function('command', body) as (command: string) => unknown
}

function buildJsFunction(pattern: string): (command: string) => unknown {
  const cached = jsCache.get(pattern)
  if (cached) {
    if (cached instanceof Error) throw cached
    return cached
  }
  let fn: (command: string) => unknown
  try {
    const t = pattern.trim()
    if (!t) throw new Error('empty js body')
    const head = stripLeadingComments(t)
    const assigned = ASSIGNED_FN.exec(head)
    if (/^async\b/.test(head)) {
      // async 返回 Promise（恒为真值）→ 会放行所有命令，必须挡住
      throw new Error(
        '不支持 async 函数：返回值是 Promise（恒为真值），请改用同步函数体',
      )
    } else if (/^function\b/.test(head)) {
      fn = compileJs(`return (${t})(command)`)
    } else if (assigned) {
      fn = compileJs(`${t}\nreturn ${assigned[1]}(command)`)
    } else if (/\breturn\b/.test(t)) {
      fn = compileJs(t)
    } else {
      try {
        fn = compileJs(`return (${t})`)
      } catch {
        // 不是表达式（throw / if / let 等语句开头）→ 原样当函数体
        fn = compileJs(t)
      }
    }
  } catch (e: any) {
    const err = new Error(e?.message || String(e))
    jsCache.set(pattern, err)
    throw err
  }
  if (jsCache.size > CACHE_LIMIT) jsCache.clear()
  jsCache.set(pattern, fn)
  return fn
}

// ==================== 匹配 ====================

/** 用单条规则测试一条命令（刻意不看 `enabled`：UI「测试」按钮要对禁用中的草稿也能试）。 */
export function testSandboxRule(
  rule: Pick<SandboxIgnoreRule, 'kind' | 'textMode' | 'pattern' | 'caseSensitive'>,
  command: string,
): SandboxRuleTestResult {
  const input = String(command ?? '').trim()
  const pattern = String(rule?.pattern ?? '').trim()
  if (!input || !pattern) return { matched: false }

  try {
    if (rule.kind === 'regex') {
      return { matched: buildRegExp(pattern, !!rule.caseSensitive).test(input) }
    }
    if (rule.kind === 'js') {
      return { matched: !!buildJsFunction(pattern)(input) }
    }
    // text
    const a = rule.caseSensitive ? input : input.toLowerCase()
    const b = rule.caseSensitive ? pattern : pattern.toLowerCase()
    const mode = rule.textMode ?? 'exact'
    const matched =
      mode === 'prefix'
        ? a.startsWith(b)
        : mode === 'suffix'
          ? a.endsWith(b)
          : a === b
    return { matched }
  } catch (e: any) {
    // 正则非法 / JS 语法或运行错误 → 一律未命中（安全侧默认）
    return { matched: false, error: e?.message || String(e) }
  }
}

/** 找出第一条命中该命令的**已启用**规则（列表顺序即优先级）；无命中返回 `null`。 */
export function findMatchingSandboxRule(
  rules: SandboxIgnoreRule[] | undefined | null,
  command: string,
): SandboxIgnoreRule | null {
  if (!rules || rules.length === 0) return null
  for (const rule of rules) {
    if (!rule || !rule.enabled) continue
    if (testSandboxRule(rule, command).matched) return rule
  }
  return null
}

// ==================== 列表顺序（= 优先级） ====================

/**
 * 把 `id` 对应规则上移 / 下移一位（`offset` < 0 上移，> 0 下移）。列表顺序即匹配优先级，是语义而非装饰。
 * 越界 / `offset` 为 0 / id 不存在时**原样返回入参数组引用**，调用方据此跳过落库与重渲染。
 */
export function moveSandboxIgnoreRule(
  rules: SandboxIgnoreRule[] | undefined | null,
  id: string,
  offset: number,
): SandboxIgnoreRule[] {
  const list = rules ?? []
  if (!list.length || !offset) return list
  const from = list.findIndex((r) => r?.id === id)
  if (from === -1) return list
  const to = from + (offset > 0 ? 1 : -1)
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const tmp = next[from]
  next[from] = next[to]
  next[to] = tmp
  return next
}

/**
 * 把 `id` 对应规则拖到第 `targetIndex` 个「间隙」（插入位置语义，0..length；见 `sandbox-rules-dnd.ts`）。
 * 拖到自己身上（`targetIndex === from` 或 `from + 1`）视为原地不动，与越界 / 未知 id / 非有限数一样
 * **原样返回入参数组引用**。
 */
export function reorderSandboxIgnoreRule(
  rules: SandboxIgnoreRule[] | undefined | null,
  id: string,
  targetIndex: number,
): SandboxIgnoreRule[] {
  const list = rules ?? []
  if (!Number.isFinite(targetIndex)) return list
  const from = list.findIndex((r) => r?.id === id)
  if (from === -1) return list
  const to = Math.max(0, Math.min(Math.trunc(targetIndex), list.length))
  if (to === from || to === from + 1) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  // 先移除后插入，插入下标要左移一位（列表短了）
  next.splice(to > from ? to - 1 : to, 0, item)
  return next
}

// ==================== 编译校验 ====================

/**
 * 只做编译期校验：正则能否编译、JS 能否解析（`new Function` 成功即通过），**不执行**规则体。
 * 运行期错误一律按「未命中」处理，不该据此拦住保存。返回 `null` = 通过；空内容不算错误（由调用方拦）。
 */
export function compileSandboxRule(
  rule: Pick<SandboxIgnoreRule, 'kind' | 'textMode' | 'pattern' | 'caseSensitive'>,
): string | null {
  const pattern = String(rule?.pattern ?? '').trim()
  if (!pattern) return null
  try {
    if (rule.kind === 'regex') buildRegExp(pattern, !!rule.caseSensitive)
    else if (rule.kind === 'js') buildJsFunction(pattern)
    return null
  } catch (e: any) {
    return e?.message || String(e)
  }
}
