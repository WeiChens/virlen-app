#!/usr/bin/env node
/**
 * update-version — 统一同步项目版本号
 *
 * 用法（注意用 run：pnpm update / npm update 是包管理器的内置命令，会改依赖）：
 *   npm run update              # 版本号 = tauri.conf.json 当前值第三位 +1
 *   npm run update -- 2.0.0     # 指定版本号（须为 x.y.z）
 *   npm run update -- --dry-run # 只预览，不写文件（-n 亦可）
 *
 * 同步目标（6 处）：
 *   - package.json               → 顶层 "version"
 *   - src-tauri/Cargo.toml       → [package] 段内的 version
 *                                  （其余 11 处 version = 是依赖版本，绝不改动）
 *   - src-tauri/Cargo.lock       → virlen-app 包自身的 version（本包条目）
 *   - src-tauri/tauri.conf.json  → 顶层 "version"（打包 / MSIX 实际读这里）
 *   - README.md / README-CN.md   → shields 版本徽章
 *
 * 基准：无参数时以 tauri.conf.json 的版本为准 —— 它是打包与 MSIX 的真实来源
 *       （见 scripts/build-msix.ps1：$Version 默认取 $confVersion），其余处长期漂移。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const abs = (rel) => resolve(root, rel)

/** 合法版本号：三段数字 x.y.z */
const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * 同步目标：每项给出「唯一匹配」的正则与用于替换的分组。
 * 正则一律只匹配「该文件里的那一处」版本字段，避免误伤依赖版本。
 */
const TARGETS = [
  {
    file: 'package.json',
    label: 'package.json',
    // 顶层 version（2 空格缩进）；依赖项的键名不是 "version"，不会命中
    pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
  },
  {
    file: 'src-tauri/Cargo.toml',
    label: 'src-tauri/Cargo.toml [package]',
    // 从 [package] 起，非贪婪匹配到第一个 version = "..."（即第 3 行的包版本）
    pattern: /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]*)(")/,
  },
  {
    file: 'src-tauri/Cargo.lock',
    label: 'src-tauri/Cargo.lock (virlen-app)',
    // Cargo.lock 由 cargo 生成，其中本包条目（name = "virlen-app"）也带 version，需一并同步
    pattern: /(name = "virlen-app"\r?\nversion = ")([^"]*)(")/,
  },
  {
    file: 'src-tauri/tauri.conf.json',
    label: 'src-tauri/tauri.conf.json',
    pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
  },
  {
    file: 'README.md',
    label: 'README.md (badge)',
    // https://img.shields.io/badge/version-<x.y.z>-blue
    pattern: /(badge\/version-)([0-9.]+)(-)/,
  },
  {
    file: 'README-CN.md',
    label: 'README-CN.md (badge)',
    pattern: /(badge\/version-)([0-9.]+)(-)/,
  },
]

const TAURI_CONF = TARGETS.find((t) => t.file === 'src-tauri/tauri.conf.json')

/** 读取某文件当前版本字段的值（读不到返回 null） */
function readVersion(rel, pattern) {
  try {
    const m = readFileSync(abs(rel), 'utf8').match(pattern)
    return m ? m[2] : null
  } catch {
    return null
  }
}

/** 第三位（patch）+1：1.1.36 → 1.1.37 */
function bumpPatch(v) {
  const [major, minor, patch] = v.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run') || args.includes('-n')
  const versionArg = args.find((a) => !a.startsWith('-'))

  const base = readVersion(TAURI_CONF.file, TAURI_CONF.pattern)
  if (!base) {
    console.error(`✖ 无法从 ${TAURI_CONF.file} 读取当前版本，已中止`)
    process.exit(1)
  }

  let next
  if (versionArg) {
    if (!SEMVER.test(versionArg)) {
      console.error(`✖ 版本号格式不合法："${versionArg}"（应为 x.y.z，如 1.2.0）`)
      process.exit(1)
    }
    next = versionArg
  } else {
    next = bumpPatch(base)
  }

  console.log('')
  console.log(`  基准版本（${TAURI_CONF.file}）: ${base}`)
  console.log(`  目标版本: ${next}${dryRun ? '   [dry-run]' : ''}`)
  console.log('')

  const lines = []
  let changed = 0

  for (const t of TARGETS) {
    let content
    try {
      content = readFileSync(abs(t.file), 'utf8')
    } catch {
      lines.push(`  – 跳过（文件不存在）: ${t.label}`)
      continue
    }

    const m = content.match(t.pattern)
    if (!m) {
      lines.push(`  ! 未匹配到版本字段: ${t.label}`)
      continue
    }

    const before = m[2]
    if (before === next) {
      lines.push(`  = 已是 ${next}: ${t.label}`)
      continue
    }

    if (!dryRun) {
      writeFileSync(abs(t.file), content.replace(t.pattern, `$1${next}$3`), 'utf8')
    }
    changed++
    lines.push(`  ✓ ${before} → ${next}  ${t.label}`)
  }

  console.log(lines.join('\n'))
  console.log('')
  console.log(`  共 ${changed} 处${dryRun ? '待更新（dry-run，未写入）' : '已更新'}`)
  console.log('')
}

main()
