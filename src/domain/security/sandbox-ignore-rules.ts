/**
 * sandbox-ignore-rules — 「忽略沙盒命令」规则（领域层，纯匹配逻辑）
 *
 * AI 执行 vitest / vite / node-gyp 等需要「管道 stdio」的命令时必须申请 `sandbox:"off"`（脱壳）——
 * 沙盒的受限令牌会让那次 spawn 直接 EPERM（根因见 AGENTS §11.2）。而每次脱壳都要走「沙盒脱壳」
 * 审批，在「安装 / 测试」这类高频命令上非常烦人。
 *
 * 本模块提供「命令 → 是否命中忽略规则」的纯函数（不依赖 store / UI / i18n）：规则存
 * `settings → 安全 → 忽略沙盒命令`，命中的命令由 `command_confirm.ts` 在交互层直接按「用户允许」放行。
 *
 * 三种规则（kind）：`text` 字面量比较（再分完全 / 前缀 / 后缀，默认忽略大小写）、`regex` 正则源码
 * （`caseSensitive` 决定是否加 `i`）、`js` 用户自写 JS（参数 `command`，返回真值即命中；写法宽容见
 * `buildJsFunction`）。匹配按列表顺序取**第一条命中且已启用**的规则（顺序即优先级）。
 *
 * ⚠️ 安全边界（改这里必须连同 `command_confirm.ts` 的拦截条件一起看）：
 * - 规则只免除「沙盒脱壳」审批，不改变命令本身的风险审批（`terminal.*` / `script.execute` 仍弹窗）；
 * - `deny` 永远优先（拒绝发生在引擎侧 Rust，规则无从介入）；`readonly` 沙盒下脱壳已被拒，规则不生效；
 * - JS 规则在应用内求值（等价于用户自己写代码）；编译或运行抛错一律按「未命中」，绝不放行。
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
 * JS 规则的默认函数体 —— 新建规则或把匹配方式切到 `js` 时预填（见设置页）。
 *
 * 刻意写成「带注释的函数声明 + `return false`」：
 * - 注释说明入口参数与返回语义，用户改起来不用猜；
 * - 默认 **不命中**（安全侧默认）：用户没改之前不会静默放行任何命令。
 */
export const SANDBOX_JS_DEFAULT_PATTERN = [
  'function matchCommand(command) {',
  '  // command = AI 实际要执行的命令（已去掉首尾空白）',
  '  // 返回真值即命中：该命令免除「沙盒脱壳」授权审批',
  '  // 例如：return command.startsWith("pnpm test")',
  '  return false',
  '}',
].join('\n')

/**
 * 各匹配方式下「匹配内容」的默认值。
 *
 * 切换匹配方式时 UI 会用它回填「匹配内容」——避免把文本 / 正则的写法
 * 带进另一种规则里（例如把正则塞进 JS 规则，只会得到一条永远报错的规则）。
 */
export function defaultSandboxRulePattern(kind: SandboxRuleKind): string {
  return kind === 'js' ? SANDBOX_JS_DEFAULT_PATTERN : ''
}

/**
 * 空列表里「一键添加」的常用规则预设（名称即 i18n key）。
 *
 * 一律用 `regex`：这类命令的真实形态是「同一族命令 + 不同参数」
 * （`pnpm install` / `pnpm i` / `npm ci`），字面量前缀匹配撑不住同族变体。
 * 预设只是**起点**，加进去之后用户仍可自由编辑。
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
 * 去掉开头的空白与注释（`//` / `/* *\/`），只看“真正第一行是什么”。
 *
 * 用户很可能在代码前写注释（默认模板本身就带注释），若直接拿 trim 后的首词判断，
 * `function` 声明会被误判成“语句体”，最终静默不命中。
 */
function stripLeadingComments(body: string): string {
  return body.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, '')
}

/** 形如 `const match = (command) => ...` / `const match = function (command) {...}` 的赋值式函数 */
const ASSIGNED_FN =
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\(?[\w$,\s()]*\)?\s*=>)/

/**
 * 编译用户写的 JS 为 `(command) => 真值` 形式的函数。
 *
 * 写法宽容度（按优先级尝试，尽量让用户「写出来就能命中」）：
 * 1. `async` 开头 → 直接报错（Promise 恒为真值，会放行一切命令）；
 * 2. `function (command) {...}` 声明（可带前置注释）→ 包成函数表达式立即调用；
 * 3. `const match = (command) => ...` 赋值式函数 → 末尾补 `return match(command)`；
 * 4. 含 `return` → 原样当函数体；
 * 5. 其他 → 先当**单表达式**（自动补 `return (...)`，如 `command.startsWith('npm')`），
 *    编译不过再回退为**原样语句体**（`throw ...` / `if (...) {...}` 这类写法）。
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
      // async 函数返回 Promise（恒为真值）→ 会放行所有命令，必须挡住
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

/**
 * 用单条规则测试一条命令。
 *
 * 刻意不看 `enabled`：UI 的「测试」按钮要对禁用中的草稿也能试；
 * 实际放行请用 `findMatchingSandboxRule`（它只认启用中的规则）。
 */
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

/**
 * 找出第一条命中该命令的**已启用**规则；无命中返回 `null`。
 *
 * 列表顺序即优先级（UI 上从上到下）。
 */
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
 * 把 `id` 对应的规则上移 / 下移一位（`offset` > 0 下移，< 0 上移）。
 *
 * 列表顺序即匹配优先级（`findMatchingSandboxRule` 取第一条命中的），
 * 所以顺序是**语义**而不是装饰，必须让用户能改。
 *
 * 越界（首条上移 / 末条下移）、`offset` 为 0 或 id 不存在时，
 * **原样返回入参数组引用** —— 调用方据此判断「无需落库 / 无需重渲染」。
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
 * 把 `id` 对应的规则拖到第 `targetIndex` 个「间隙」（插入位置语义，0..length）。
 *
 * 拖拽排序用（列表 UI 用 pointer 事件自实现，见 `ui/pages/Settings/sandbox-rules-dnd.ts`）。
 * 拖到自己身上（`targetIndex === from` 或 `from + 1`，即原位的前后两个间隙）属于原地不动，
 * 此时与越界、未知 id、非有限数一样**原样返回入参数组引用**，调用方据此跳过落库。
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
 * 只做「编译期」校验：正则能否编译、JS 能否解析（`new Function` 成功即通过）。
 *
 * 刻意**不执行**规则体。规则在生产探测中抛错（例如 `command.match(/x/)[0]`
 * 遇到不含 x 的命令取下标）是设计允许的 —— 运行期错误一律按「未命中」处理，
 * 不该据此拦住保存（旧实现拿 `testSandboxRule(draft, '__probe__')` 当编译校验，
 * 把这类运行期错误误报成「无法编译」）。
 *
 * 返回 `null` 表示通过；否则返回错误信息。空内容不算编译错误（由调用方拦）。
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
