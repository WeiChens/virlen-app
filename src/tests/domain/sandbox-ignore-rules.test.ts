/**
 * sandbox-ignore-rules 领域模块单测 — 「忽略沙盒命令」规则匹配
 *
 * 覆盖：文本（完全 / 前缀 / 后缀 / 大小写）、正则（含非法正则容错）、
 * JS（默认模板、函数声明 / 表达式 / 赋值式箭头函数几种写法、async 拒绝、
 * 运行期报错容错）、启用开关与列表优先级，以及空内容 / 空命令的边界。
 * 匹配结果直接决定是否免除沙盒脱壳审批，因此
 * **一切异常都必须落到「未命中」**（安全侧默认）。
 */
import { describe, it, expect } from 'vitest'
import {
  compileSandboxRule,
  createSandboxIgnoreRule,
  createSandboxIgnoreRuleFromPreset,
  defaultSandboxRulePattern,
  findMatchingSandboxRule,
  moveSandboxIgnoreRule,
  reorderSandboxIgnoreRule,
  SANDBOX_RULE_PRESETS,
  testSandboxRule,
  SANDBOX_JS_DEFAULT_PATTERN,
  type SandboxIgnoreRule,
} from '@/domain/security/sandbox-ignore-rules'

/** 构造一条规则（测试里显式给 id，避免依赖 uuid） */
function rule(patch: Partial<SandboxIgnoreRule>): SandboxIgnoreRule {
  return {
    id: patch.id ?? 'r1',
    name: patch.name ?? 'test',
    enabled: patch.enabled ?? true,
    kind: patch.kind ?? 'text',
    textMode: patch.textMode ?? 'exact',
    pattern: patch.pattern ?? '',
    caseSensitive: patch.caseSensitive ?? false,
  }
}

describe('sandbox-ignore-rules · 文本匹配', () => {
  it('默认完全匹配且忽略大小写（Windows 命令不区分大小写）', () => {
    const r = rule({ kind: 'text', textMode: 'exact', pattern: 'npm install' })
    expect(testSandboxRule(r, 'npm install').matched).toBe(true)
    expect(testSandboxRule(r, 'NPM INSTALL').matched).toBe(true)
    expect(testSandboxRule(r, 'npm  install').matched).toBe(false)
    expect(testSandboxRule(r, 'npm install --save').matched).toBe(false)
  })

  it('忽略首尾空白', () => {
    const r = rule({ kind: 'text', pattern: 'npm test' })
    expect(testSandboxRule(r, '  npm test \n').matched).toBe(true)
  })

  it('前缀 / 后缀匹配', () => {
    const prefix = rule({ kind: 'text', textMode: 'prefix', pattern: 'npm' })
    expect(testSandboxRule(prefix, 'npm install').matched).toBe(true)
    expect(testSandboxRule(prefix, 'pnpm install').matched).toBe(false)

    const suffix = rule({
      kind: 'text',
      textMode: 'suffix',
      pattern: '--version',
    })
    expect(testSandboxRule(suffix, 'node --version').matched).toBe(true)
    expect(testSandboxRule(suffix, 'node --version-all').matched).toBe(false)
  })

  it('区分大小写开关生效', () => {
    const r = rule({
      kind: 'text',
      pattern: 'NPM',
      textMode: 'prefix',
      caseSensitive: true,
    })
    expect(testSandboxRule(r, 'npm install').matched).toBe(false)
    expect(testSandboxRule(r, 'NPM install').matched).toBe(true)
  })
})

describe('sandbox-ignore-rules · 正则匹配', () => {
  it('按正则匹配整条命令（默认忽略大小写）', () => {
    const r = rule({
      kind: 'regex',
      pattern: '^npm (run )?(install|test)\\b',
    })
    expect(testSandboxRule(r, 'npm test').matched).toBe(true)
    expect(testSandboxRule(r, 'NPM Run TEST').matched).toBe(true)
    expect(testSandboxRule(r, 'npm run build').matched).toBe(false)
  })

  it('非法正则 → 未命中并带错误信息（不放行）', () => {
    const r = rule({ kind: 'regex', pattern: '([unclosed' })
    const res = testSandboxRule(r, 'npm test')
    expect(res.matched).toBe(false)
    expect(res.error).toBeTruthy()
  })
})

describe('sandbox-ignore-rules · JS 脚本匹配', () => {
  it('裸表达式自动补 return（写出就能命中）', () => {
    const r = rule({ kind: 'js', pattern: 'command.startsWith("pnpm")' })
    expect(testSandboxRule(r, 'pnpm install').matched).toBe(true)
    expect(testSandboxRule(r, 'npm install').matched).toBe(false)
  })

  it('完整 return 语句 / 多行逻辑', () => {
    const r = rule({
      kind: 'js',
      pattern:
        'const parts = command.split(" ");\nreturn parts[0] === "npx" && parts[1] === "vitest"',
    })
    expect(testSandboxRule(r, 'npx vitest run').matched).toBe(true)
    expect(testSandboxRule(r, 'npx eslint .').matched).toBe(false)
  })

  it('语法错误 → 未命中并带错误信息', () => {
    const res = testSandboxRule(
      rule({ kind: 'js', pattern: 'command.)(' }),
      'npm test',
    )
    expect(res.matched).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('运行期抛错 → 按未命中处理', () => {
    const res = testSandboxRule(
      rule({ kind: 'js', pattern: 'throw new Error("boom")' }),
      'npm test',
    )
    expect(res.matched).toBe(false)
    expect(res.error).toContain('boom')
  })
})

describe('sandbox-ignore-rules · JS 默认模板与写法宽容', () => {
  it('新建 js 规则预填「带注释的函数模板」，且默认不命中任何命令', () => {
    const r = createSandboxIgnoreRule({ kind: 'js' })
    expect(r.pattern).toBe(SANDBOX_JS_DEFAULT_PATTERN)
    expect(r.pattern).toContain('function matchCommand(command)')
    expect(r.pattern).toContain('//')
    expect(r.pattern).toContain('return false')
    // 默认模板必须能编译（无 error），但一律不命中 —— 用户没改之前绝不放行
    const res = testSandboxRule(r, 'pnpm install')
    expect(res.matched).toBe(false)
    expect(res.error).toBeUndefined()
  })

  it('文本 / 正则的默认值为空串，仅 js 有预填模板（切换匹配方式时回填）', () => {
    expect(defaultSandboxRulePattern('text')).toBe('')
    expect(defaultSandboxRulePattern('regex')).toBe('')
    expect(defaultSandboxRulePattern('js')).toBe(SANDBOX_JS_DEFAULT_PATTERN)
  })

  it('函数声明前带注释与空行也能识别（默认模板形态）', () => {
    const r = rule({
      kind: 'js',
      pattern: [
        '// 前端依赖安装',
        '/* 多行',
        '   注释 */',
        '',
        'function (command) {',
        '  return command.startsWith("pnpm")',
        '}',
      ].join('\n'),
    })
    expect(testSandboxRule(r, 'pnpm test').matched).toBe(true)
    expect(testSandboxRule(r, 'npm test').matched).toBe(false)
  })

  it('const 赋值式箭头函数也能用（自动补调用）', () => {
    const r = rule({
      kind: 'js',
      pattern: [
        'const match = (command) => {',
        '  return command.includes("node-gyp")',
        '}',
      ].join('\n'),
    })
    expect(testSandboxRule(r, 'npm rebuild node-gyp').matched).toBe(true)
    expect(testSandboxRule(r, 'npm ci').matched).toBe(false)
  })

  it('async 函数 → 直接报错（Promise 恒为真值，会放行一切命令）', () => {
    const res = testSandboxRule(
      rule({ kind: 'js', pattern: 'async function f(command) { return true }' }),
      'rm -rf /',
    )
    expect(res.matched).toBe(false)
    expect(res.error).toContain('async')
  })
})

describe('sandbox-ignore-rules · 边界与优先级', () => {
  it('空命令 / 空内容 → 一律未命中', () => {
    expect(testSandboxRule(rule({ pattern: 'npm' }), '').matched).toBe(false)
    expect(testSandboxRule(rule({ pattern: '   ' }), 'npm test').matched).toBe(
      false,
    )
  })

  it('禁用的规则不参与匹配（findMatchingSandboxRule 只看启用项）', () => {
    const disabled = rule({
      id: 'a',
      name: 'disabled',
      enabled: false,
      pattern: 'npm test',
    })
    const enabled = rule({
      id: 'b',
      name: 'enabled',
      kind: 'text',
      textMode: 'prefix',
      pattern: 'npm',
    })
    expect(findMatchingSandboxRule([disabled], 'npm test')).toBeNull()
    const hit = findMatchingSandboxRule([disabled, enabled], 'npm test')
    expect(hit?.id).toBe('b')
  })

  it('按列表顺序取第一条命中（列表顺序即优先级）', () => {
    const first = rule({ id: 'first', pattern: 'npm', textMode: 'prefix' })
    const second = rule({ id: 'second', pattern: 'npm test' })
    expect(findMatchingSandboxRule([first, second], 'npm test')?.id).toBe(
      'first',
    )
    expect(findMatchingSandboxRule([second, first], 'npm test')?.id).toBe(
      'second',
    )
  })

  it('空列表 / undefined 安全', () => {
    expect(findMatchingSandboxRule([], 'npm test')).toBeNull()
    expect(findMatchingSandboxRule(undefined, 'npm test')).toBeNull()
    expect(findMatchingSandboxRule(null, 'npm test')).toBeNull()
  })
})

describe('sandbox-ignore-rules · 列表顺序（= 优先级）', () => {
  const a = rule({ id: 'a' })
  const b = rule({ id: 'b' })
  const c = rule({ id: 'c' })
  const list = [a, b, c]

  it('上移 / 下移相邻一位', () => {
    expect(moveSandboxIgnoreRule(list, 'c', -1).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ])
    expect(moveSandboxIgnoreRule(list, 'a', 1).map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ])
  })

  it('不改动入参数组（纯函数）', () => {
    moveSandboxIgnoreRule(list, 'a', 1)
    expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('越界 / 未知 id / offset 为 0 → 原样返回同一引用（调用方据此跳过落库）', () => {
    expect(moveSandboxIgnoreRule(list, 'a', -1)).toBe(list)
    expect(moveSandboxIgnoreRule(list, 'c', 1)).toBe(list)
    expect(moveSandboxIgnoreRule(list, 'nope', 1)).toBe(list)
    expect(moveSandboxIgnoreRule(list, 'a', 0)).toBe(list)
    expect(moveSandboxIgnoreRule(null, 'a', 1)).toEqual([])
  })

  it('reorderSandboxIgnoreRule 拖到任意间隙（插入位置语义，0..n）', () => {
    expect(reorderSandboxIgnoreRule(list, 'a', 3).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(reorderSandboxIgnoreRule(list, 'c', 0).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ])
    // 拖到中间：b 从原位到「第 1 个间隙」→ 位置没变
    expect(reorderSandboxIgnoreRule(list, 'b', 1).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('reorderSandboxIgnoreRule：拖到自己身上 / 越界 / 非有限数 → 同一引用', () => {
    // 原位的前后两个间隙都表示「原地不动」（拖拽把手按在自己行上也常见）
    expect(reorderSandboxIgnoreRule(list, 'b', 1)).toBe(list)
    expect(reorderSandboxIgnoreRule(list, 'b', 2)).toBe(list)
    expect(reorderSandboxIgnoreRule(list, 'a', 0)).toBe(list)
    // 非有限数 / 未知 id 不做任何猜测
    expect(reorderSandboxIgnoreRule(list, 'a', Number.NaN)).toBe(list)
    expect(reorderSandboxIgnoreRule(list, 'a', Number.POSITIVE_INFINITY)).toBe(
      list,
    )
    expect(reorderSandboxIgnoreRule(list, 'nope', 1)).toBe(list)
    expect(reorderSandboxIgnoreRule(null, 'a', 1)).toEqual([])
  })

  it('reorderSandboxIgnoreRule：超范围夹到首 / 末（不规则点击不报错）', () => {
    expect(reorderSandboxIgnoreRule(list, 'a', 99).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(reorderSandboxIgnoreRule(list, 'c', -5).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ])
    // 纯函数：入参数组不被修改
    expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('sandbox-ignore-rules · 编译校验', () => {
  it('非法正则 → 返回错误信息；合法 → null', () => {
    expect(
      compileSandboxRule(rule({ kind: 'regex', pattern: '([unclosed' })),
    ).toBeTruthy()
    expect(
      compileSandboxRule(rule({ kind: 'regex', pattern: '^npm' })),
    ).toBeNull()
  })

  it('JS 语法错误 → 返回错误信息；可编译 → null', () => {
    expect(
      compileSandboxRule(rule({ kind: 'js', pattern: 'command.)(' })),
    ).toBeTruthy()
    expect(
      compileSandboxRule(
        rule({ kind: 'js', pattern: SANDBOX_JS_DEFAULT_PATTERN }),
      ),
    ).toBeNull()
  })

  it('只在运行时抛错的规则能通过编译校验（不再被误判为「无法编译」）', () => {
    // 旧实现拿 testSandboxRule(rule, 探测命令) 当编译校验，
    // 这类规则在探测命令上必然抛错 → 保存被无理由拦住
    const r = rule({ kind: 'js', pattern: 'return command.match(/npm/)[0]' })
    expect(compileSandboxRule(r)).toBeNull()
    expect(testSandboxRule(r, '__virlen_probe__').error).toBeTruthy()
    // 命中的命令上照常工作
    expect(testSandboxRule(r, 'npm install').matched).toBe(true)
  })

  it('空内容不算编译错误（由保存校验单独拦）', () => {
    expect(compileSandboxRule(rule({ pattern: '   ' }))).toBeNull()
  })
})

describe('sandbox-ignore-rules · 常用规则预设（空列表一键添加）', () => {
  /** 每个预设挑一条真实命令：既要能编译，也要真命中 */
  const SAMPLES: Record<string, string> = {
    install: 'pnpm install --frozen-lockfile',
    test: 'npm test',
    build: 'pnpm run build',
    native: 'npm rebuild node-gyp',
    pytest: 'python -m pytest -q',
  }

  it('预设数量与 key 稳定，且每条都能编译、能命中样例命令', () => {
    expect(SANDBOX_RULE_PRESETS.map((p) => p.key)).toEqual([
      'install',
      'test',
      'build',
      'native',
      'pytest',
    ])
    for (const preset of SANDBOX_RULE_PRESETS) {
      const r = createSandboxIgnoreRuleFromPreset(preset)
      expect(compileSandboxRule(r), preset.key).toBeNull()
      expect(testSandboxRule(r, SAMPLES[preset.key]).matched, preset.key).toBe(
        true,
      )
    }
  })

  it('预设生成的规则默认启用、带名称', () => {
    const r = createSandboxIgnoreRuleFromPreset(SANDBOX_RULE_PRESETS[0])
    expect(r.enabled).toBe(true)
    expect(r.name).toBe('安装依赖')
    expect(r.id).toBeTruthy()
    // 同族变体都命中（预设用正则而不是字面量前缀的原因）
    expect(testSandboxRule(r, 'npm ci').matched).toBe(true)
    expect(testSandboxRule(r, 'yarn add lodash').matched).toBe(true)
  })
})

describe('sandbox-ignore-rules · 规则构造', () => {
  it('createSandboxIgnoreRule 默认值合理且 id 唯一', () => {
    const a = createSandboxIgnoreRule()
    const b = createSandboxIgnoreRule({ name: 'x', kind: 'js' })
    expect(a.enabled).toBe(true)
    expect(a.kind).toBe('text')
    expect(a.textMode).toBe('exact')
    expect(a.caseSensitive).toBe(false)
    // text / regex 默认内容为空（需用户填），js 预填默认模板
    expect(a.pattern).toBe('')
    expect(b.pattern).toBe(SANDBOX_JS_DEFAULT_PATTERN)
    expect(b.name).toBe('x')
    expect(b.kind).toBe('js')
    expect(a.id).not.toBe(b.id)
    expect(a.id).toBeTruthy()
  })
})
