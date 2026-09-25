/**
 * 一次性迁移脚本（机制 C / 步骤 ④）：摘除 TS 侧工具定义体，只留执行器 + i18n 文案
 *
 * 背景：工具定义已收敛到权威源
 *   `src-tauri/src/agent/tool_defs/definitions.json`
 * 前端不再编写定义，注册时只提供执行器与 UI 文案：
 *
 *   // 迁移前
 *   toolRegistry.register(
 *     { name: 'read_file', label: t('读取文件'), description: '…', parameters: { … } },
 *     (async (args, ctx) => { … }) as ToolExecutor,
 *   )
 *
 *   // 迁移后
 *   toolRegistry.register(
 *     'read_file',
 *     (async (args, ctx) => { … }) as ToolExecutor,
 *     t('读取文件'),
 *   )
 *
 * ⚠️ 为什么不用 `typescript` 的编译器 API：本项目锁的是 typescript@7（Go 原生编译器），
 *    它的 npm 包**不导出** `createSourceFile` 等 JS 编译器 API（实测 keys 只有 2 个）。
 *    因此这里自写词法扫描：识别字符串 / 模板字面量 / 行注释 / 块注释 / 正则字面量，
 *    并按括号深度定位「顶层参数分隔逗号」——不用正则去猜对象体，避免花括号误伤。
 *
 * 用法：
 *   node scripts/migrate-tool-defs.mjs           # 预演（只报告，不改文件）
 *   node scripts/migrate-tool-defs.mjs --apply   # 实际改写
 */
import fs from 'node:fs'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const TOOLS_DIR = path.resolve('src/infrastructure/tools')
/** 非「一个工具一个文件」的公共文件 */
const SKIP_FILES = new Set(['index.ts', 'common.ts', 'output-store.ts'])
/** 正则字面量起点启发式：这些符号后面出现的 `/` 视为正则而非除号 */
const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', 'return'])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts') && !SKIP_FILES.has(entry.name)) out.push(full)
  }
  return out
}

/** 从 `(` 开始扫描，返回该括号的配对位置与「深度 1 的逗号」列表 */
function scanCall(source, openParen) {
  let depth = 0
  let i = openParen
  const commas = []
  let lastMeaningful = ''

  const isRegexStart = (idx) => {
    // 向前找第一个非空白字符
    let j = idx - 1
    while (j >= 0 && /\s/.test(source[j])) j--
    if (j < 0) return true
    const ch = source[j]
    if (REGEX_PREFIX.has(ch)) return true
    // `return /re/` 这类
    if (/[a-zA-Z]/.test(ch)) {
      const word = source.slice(Math.max(0, j - 10), j + 1)
      return /\b(return|typeof|instanceof|in|of|case|do|else|void|delete|new)\s*$/.test(word)
    }
    return false
  }

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    // 字符串 / 模板字面量
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) { i++; break }
        i++
      }
      lastMeaningful = quote
      continue
    }
    // 行注释
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    // 块注释
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 正则字面量
    if (ch === '/' && isRegexStart(i)) {
      i++
      let inClass = false
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) { i++; break }
        else if (source[i] === '\n') break
        i++
      }
      lastMeaningful = '/'
      continue
    }

    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return { closeParen: i, commas }
    } else if (ch === ',' && depth === 1) {
      commas.push(i)
    }
    if (!/\s/.test(ch)) lastMeaningful = ch
    i++
  }
  return { closeParen: -1, commas }
}

const firstNonSpace = (s, from, to) => {
  let i = from
  while (i < to && /\s/.test(s[i])) i++
  return i
}
const lastNonSpace = (s, from, to) => {
  let i = to - 1
  while (i > from && /\s/.test(s[i])) i--
  return i + 1
}

/** 找出文件里所有 `…register(` 调用，生成替换方案 */
function planEdits(file, source) {
  const edits = []
  const warnings = []
  const re = /\b([A-Za-z_$][\w$]*)\.register\s*\(/g
  let m
  while ((m = re.exec(source))) {
    const openParen = m.index + m[0].length - 1
    const { closeParen, commas } = scanCall(source, openParen)
    if (closeParen < 0 || commas.length === 0) {
      warnings.push(`找不到参数边界，跳过（偏移 ${m.index}）`)
      continue
    }
    const arg1Start = firstNonSpace(source, openParen + 1, commas[0])
    const arg1End = lastNonSpace(source, openParen + 1, commas[0])
    const arg1 = source.slice(arg1Start, arg1End)

    // 定义体必须是以 `{` 开头的对象字面量
    if (arg1[0] !== '{') {
      warnings.push(`参数 1 不是对象字面量，跳过：${arg1.slice(0, 50)}…`)
      continue
    }

    // 工具名：取定义体里**第一个** `name:`（对象字面量按 name 开头书写）
    const nameMatch = /(?:^|[\s{,])name\s*:\s*(['"`])([^'"`]+)\1/.exec(arg1)
    if (!nameMatch) {
      warnings.push('未能解析 name，跳过')
      continue
    }
    const nameLiteral = `${nameMatch[1]}${nameMatch[2]}${nameMatch[1]}`
    // UI 文案：`label: t('…')`（缺省则迁移后不传 label）
    const labelMatch = /(?:^|[\s{,])label\s*:\s*([^,\n}]+)/.exec(arg1)

    // 第二个参数（执行器）原样保留
    const arg2Start = firstNonSpace(source, commas[0] + 1, commas[1] ?? closeParen)
    const arg2End = lastNonSpace(source, commas[0] + 1, commas[1] ?? closeParen)
    const executor = source.slice(arg2Start, arg2End)

    // ⚠️ 末尾**不能**带逗号：被替换区间的右侧原本就是 `,\n)`（参数 2 后面的那个逗号），
    //    多加一个就会变成 `executor,,` —— 语法错误。逗号只加在参数之间。
    const replacement =
      `\n    ${nameLiteral},\n    ${executor}` +
      (labelMatch ? `,\n    ${labelMatch[1].trim()}` : '')

    edits.push({
      start: arg1Start,
      end: arg2End,
      text: replacement,
      name: nameMatch[2],
      hasLabel: !!labelMatch,
    })
    re.lastIndex = closeParen + 1
  }
  return { edits, warnings }
}

function main() {
  const files = walk(TOOLS_DIR).sort()
  let totalEdits = 0
  let touchedFiles = 0
  const allWarnings = []

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const { edits, warnings } = planEdits(file, source)
    warnings.forEach((w) => allWarnings.push(`${path.relative(process.cwd(), file)}: ${w}`))
    if (edits.length === 0) continue

    totalEdits += edits.length
    touchedFiles++
    console.log(
      `${APPLY ? '改写' : '待改'} ${path.relative(process.cwd(), file).padEnd(58)} ` +
        edits.map((e) => `${e.name}${e.hasLabel ? '' : '(无 label)'}`).join(', '),
    )

    if (APPLY) {
      let next = source
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
      }
      fs.writeFileSync(file, next, 'utf8')
    }
  }

  console.log(
    `\n${APPLY ? '已改写' : '待改写'}：${totalEdits} 处调用 / ${touchedFiles} 个文件（扫描 ${files.length} 个文件）`,
  )
  if (allWarnings.length) {
    console.log('\n⚠️ 跳过项：')
    allWarnings.forEach((w) => console.log(`  - ${w}`))
  }
  if (!APPLY && totalEdits > 0) console.log('\n预演结束。确认无误后加 --apply 执行。')
}

main()
