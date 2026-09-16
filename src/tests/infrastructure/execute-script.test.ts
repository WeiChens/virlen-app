/**
 * execute_script 脚本文件编码测试
 *
 * 回归背景：Windows PowerShell 5.1 读取**无 BOM** 的 .ps1 时不猜 UTF-8，而是按
 * 系统 ANSI 代码页（中文系统 CP936）解析，脚本里的中文字面量在解析阶段就变成乱码
 * （"脚本" → "鑴氭湰"），此时再怎么设置 [Console]::OutputEncoding 也还原不回来。
 * 因此写盘时要给 Windows 上的 .ps1/.psm1 补 UTF-8 BOM。
 *
 * 边界：不能给 .sh/.js/.py 等其它脚本加 BOM（.sh 的 shebang 会失效）。
 * 与 Rust 侧 `with_script_bom` 的用例一一对应。
 */
import { describe, it, expect } from 'vitest'
import { applyScriptBom } from '@/infrastructure/tools/execute/execute-script'

const BOM = '\uFEFF'

describe('applyScriptBom（PowerShell 脚本中文乱码修复）', () => {
  it('Windows + .ps1/.psm1 → 补 UTF-8 BOM', () => {
    expect(applyScriptBom('C:/ws/run.ps1', 'abc', 'windows')).toBe(BOM + 'abc')
    expect(applyScriptBom('C:\\ws\\run.PSM1', 'abc', 'windows')).toBe(
      BOM + 'abc',
    )
  })

  it('非 Windows → 不加（macOS/Linux 的 pwsh 默认按 UTF-8 解析）', () => {
    expect(applyScriptBom('/ws/run.ps1', 'abc', 'macos')).toBe('abc')
    expect(applyScriptBom('/ws/run.ps1', 'abc', 'linux')).toBe('abc')
  })

  it('Windows 上的非 PowerShell 脚本 → 不加（.sh 加 BOM 会让 shebang 失效）', () => {
    expect(applyScriptBom('C:/ws/run.sh', '#!/bin/sh\nabc', 'windows')).toBe(
      '#!/bin/sh\nabc',
    )
    expect(applyScriptBom('C:/ws/run.js', 'abc', 'windows')).toBe('abc')
    expect(applyScriptBom('C:/ws/run.py', 'abc', 'windows')).toBe('abc')
    // 形似但不是 PowerShell 扩展名
    expect(applyScriptBom('C:/ws/run.ps1.bak', 'abc', 'windows')).toBe('abc')
  })

  it('已有 BOM → 幂等，不重复叠加', () => {
    const once = applyScriptBom('C:/ws/run.ps1', 'abc', 'windows')
    expect(applyScriptBom('C:/ws/run.ps1', once, 'windows')).toBe(once)
  })
})
