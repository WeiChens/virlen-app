/**
 * 把「磁盘上的新内容」以**最小编辑**的方式写进 Monaco（而不是整篇替换）。
 *
 * 两条约束决定了它必须存在于组件之外：
 * 1. 要能被业务侧在**非 React 渲染周期**里调用（文件监听回调）—— 先改编辑器、再同步 state；
 * 2. 先改完编辑器后，`@monaco-editor/react` 的受控 `value` 同步会因为
 *    `value === editor.getValue()` 直接短路，不会再来一次整篇替换
 *    （它的实现见 `node_modules/@monaco-editor/react`：`t !== o.current.getValue()` 才 executeEdits）。
 *
 * 撤销栈：一次外部更新 = 一步（前后各一个 `pushUndoStop`），Ctrl+Z 能整体退回去。
 */
import type * as MonacoNs from 'monaco-editor'
import { computeMiddleEdit } from '@/utils/minimal-text-edit'

/** 撤销栈 / 编辑来源里的名字（排查时能看出这次改动不是用户敲的） */
const SOURCE = 'workspace-file-disk-change'

/** 只用到的那一小块 Monaco 形状：拿真编辑器、或测试里的替身都能喂进来 */
export interface TextChangeModel {
  getValue: () => string
  getPositionAt: (offset: number) => { lineNumber: number; column: number }
  getOffsetAt: (position: { lineNumber: number; column: number }) => number
  getFullModelRange: () => MonacoNs.IRange
}

export interface TextChangeEditor {
  getModel: () => TextChangeModel | null
  pushUndoStop: () => boolean
  executeEdits: (
    source: string | null,
    edits: MonacoNs.editor.IIdentifiedSingleEditOperation[],
  ) => boolean
}

/**
 * 用编辑器换内容；返回是否真的动了（内容已相同 / 没有 model 时返回 false）。
 *
 * ⚠️ 偏移 → 行列 → 偏移的往返必须严格相等。正常情况恒等（Monaco 的 buffer 自己处理
 * CRLF 与代理对），但混合行尾 / 孤立 `\r` 这类边角上宁可整篇替换 ——
 * 区间错一个字符就是静默的数据损坏，不值得为「光标不动」赌。
 */
export function applyTextChange(
  editor: TextChangeEditor,
  nextText: string,
): boolean {
  const model = editor.getModel()
  if (!model) return false

  const prevText = model.getValue()
  if (prevText === nextText) return false

  const edit = computeMiddleEdit(prevText, nextText)
  if (!edit) return false

  const start = model.getPositionAt(edit.startOffset)
  const end = model.getPositionAt(edit.endOffset)
  const exact =
    model.getOffsetAt(start) === edit.startOffset &&
    model.getOffsetAt(end) === edit.endOffset

  const range: MonacoNs.IRange = exact
    ? {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      }
    : model.getFullModelRange()

  editor.pushUndoStop()
  editor.executeEdits(SOURCE, [
    {
      range,
      text: exact ? edit.text : nextText,
      // 与受控 value 同步同一口径：让光标 / 装饰器跟着这段编辑走，而不是原地不动
      forceMoveMarkers: true,
    },
  ])
  editor.pushUndoStop()
  return true
}
