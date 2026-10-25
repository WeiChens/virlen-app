// @vitest-environment node
/**
 * 把磁盘上的新内容写进 Monaco 的方式：**最小编辑**，而不是整篇替换。
 *
 * 为什么值得单独守一条：整篇替换会让光标跳到文末、滚动被弹回、撤销栈多一大步 ——
 * 正是「文件被 AI 改了一行，编辑器却整篇重刷」那种观感。这里用一个只认 `\n` 的
 * 假 model 验：区间算得对不对、内容能不能真的变过去、算不准时会不会退回整篇替换。
 */
import { describe, expect, it } from 'vitest'
import { applyTextChange } from '@/ui/components/code-editor/applyTextChange'

interface Position {
  lineNumber: number
  column: number
}

interface Range {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/** 偏移 → 行列（只处理 `\n`：用例里没有 CRLF） */
function posAt(text: string, offset: number): Position {
  let lineNumber = 1
  let column = 1
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === '\n') {
      lineNumber += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { lineNumber, column }
}

/** 行列 → 偏移 */
function offsetAt(text: string, position: Position): number {
  let offset = 0
  for (let line = 1; line < position.lineNumber; line += 1) {
    const newline = text.indexOf('\n', offset)
    if (newline < 0) return text.length
    offset = newline + 1
  }
  return Math.min(text.length, offset + position.column - 1)
}

function rangeFromOffsets(text: string, start: number, end: number): Range {
  const from = posAt(text, start)
  const to = posAt(text, end)
  return {
    startLineNumber: from.lineNumber,
    startColumn: from.column,
    endLineNumber: to.lineNumber,
    endColumn: to.column,
  }
}

/** 只实现 `applyTextChange` 用到的那几个成员；`executeEdits` 真的把文本改掉 */
function fakeEditor(initial: string) {
  let text = initial
  const calls: { source: string | null; range: Range; text: string }[] = []

  const editor = {
    getModel: () => ({
      getValue: () => text,
      getPositionAt: (offset: number) => posAt(text, offset),
      getOffsetAt: (position: Position) => offsetAt(text, position),
      getFullModelRange: () => rangeFromOffsets(text, 0, text.length),
    }),
    pushUndoStop: () => true,
    executeEdits: (
      source: string | null,
      edits: { range: Range; text: string; forceMoveMarkers?: boolean }[],
    ) => {
      for (const edit of edits) {
        calls.push({ source, range: edit.range, text: edit.text })
        const start = offsetAt(text, {
          lineNumber: edit.range.startLineNumber,
          column: edit.range.startColumn,
        })
        const end = offsetAt(text, {
          lineNumber: edit.range.endLineNumber,
          column: edit.range.endColumn,
        })
        text = text.slice(0, start) + edit.text + text.slice(end)
      }
      return true
    },
  }

  return {
    editor,
    calls,
    get value() {
      return text
    },
  }
}

describe('applyTextChange', () => {
  it('中间只改一行：只替换那一小段，不是整篇', () => {
    const fake = fakeEditor('第一行\n第二行\n第三行')
    expect(applyTextChange(fake.editor, '第一行\n第二行改了\n第三行')).toBe(true)

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].source).toBe('workspace-file-disk-change')
    expect(fake.calls[0].range).toEqual({
      startLineNumber: 2,
      startColumn: 4,
      endLineNumber: 2,
      endColumn: 4,
    })
    expect(fake.calls[0].text).toBe('改了')
    expect(fake.value).toBe('第一行\n第二行改了\n第三行')
  })

  it('文首插入一行：区间落在第一行，后面的内容一个字都不动', () => {
    const fake = fakeEditor('b\nc')
    expect(applyTextChange(fake.editor, 'a\nb\nc')).toBe(true)

    expect(fake.calls[0].range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    })
    expect(fake.calls[0].text).toBe('a\n')
    expect(fake.value).toBe('a\nb\nc')
  })

  it('内容完全没变（watcher 只是看到 mtime 变了）→ 一次编辑都不发', () => {
    const fake = fakeEditor('same')
    expect(applyTextChange(fake.editor, 'same')).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  it('内容全变 → 退化成一次整篇替换，但结果必须逐字正确', () => {
    const fake = fakeEditor('aaa')
    expect(applyTextChange(fake.editor, '完全不同的内容')).toBe(true)
    expect(fake.calls).toHaveLength(1)
    expect(fake.value).toBe('完全不同的内容')
  })

  it('没有 model（编辑器正在销毁）→ 什么都不做', () => {
    expect(
      applyTextChange(
        {
          getModel: () => null,
          pushUndoStop: () => true,
          executeEdits: () => true,
        },
        'x',
      ),
    ).toBe(false)
  })
})
