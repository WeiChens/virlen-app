/**
 * editorCommand.ts 工具函数测试
 *
 * 覆盖场景：
 * - buildEditorCommand 占位符替换（filePath / line / column）
 * - 未提供的 line / column 默认补 0
 * - 含空格、中文等特殊路径
 * - 空模板边界
 */
import { describe, it, expect } from 'vitest'
import { buildEditorCommand } from '@/domain/editor'

describe('buildEditorCommand', () => {
  it('应替换 filePath 与 line 占位符', () => {
    const cmd = buildEditorCommand('code -g "${filePath}:${line}"', {
      filePath: 'C:/a/b.ts',
      line: 42,
    })
    expect(cmd).toBe('code -g "C:/a/b.ts:42"')
  })

  it('未提供的 line 默认补 0', () => {
    const cmd = buildEditorCommand('code -g "${filePath}:${line}"', {
      filePath: 'C:/a/b.ts',
    })
    expect(cmd).toBe('code -g "C:/a/b.ts:0"')
  })

  it('未提供的 column 默认补 0', () => {
    const cmd = buildEditorCommand('code -g "${filePath}:${line}:${column}"', {
      filePath: 'C:/a/b.ts',
    })
    expect(cmd).toBe('code -g "C:/a/b.ts:0:0"')
  })

  it('line 为 0 时不被覆盖', () => {
    const params = { filePath: 'C:/a/b.ts', line: 0 }
    buildEditorCommand('code -g "${filePath}:${line}"', params)
    expect(params.line).toBe(0)
  })

  it('支持仅 filePath 的模板（含空格/中文路径）', () => {
    const cmd = buildEditorCommand('code --reuse-window "${filePath}"', {
      filePath: 'C:/my project/含空格 中文.ts',
    })
    expect(cmd).toBe('code --reuse-window "C:/my project/含空格 中文.ts"')
  })

  it('支持自定义占位符（column 等）', () => {
    const cmd = buildEditorCommand(
      'open -a App --args ${filePath}:${column}',
      { filePath: '/x/y.ts', column: 8 },
    )
    expect(cmd).toBe('open -a App --args /x/y.ts:8')
  })

  it('空模板返回空字符串', () => {
    expect(buildEditorCommand('', { filePath: 'a.ts' })).toBe('')
  })

  it('无占位符模板原样返回', () => {
    expect(buildEditorCommand('notepad.exe', { filePath: 'a.ts' })).toBe(
      'notepad.exe',
    )
  })
})
