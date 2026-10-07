/**
 * editable — 可编辑控件（input / textarea）的右键菜单工厂。
 *
 * 原生右键菜单在生产环境被全局禁用（见 ContextMenu/index.tsx、layout/WindowLayout），别处浮层都自补了
 * 菜单，但输入框一直漏着 —— 而它恰是原生菜单真有内容的地方（剪切 / 复制 / 粘贴 / 全选）。
 *
 * 只做「文本」，不做撤销 / 重做：撤销栈属于浏览器，replaceValue 会把它截断，做了也是假的（请用 Ctrl+Z）；
 * 「粘贴」只管文本，聊天输入框的图片 / 文件粘贴有专属链路，仍走 Ctrl+V（见 input/use-input-handlers）。
 *
 * 两个只在这种场景出现的坑（本文件存在的主要理由）：
 * 1) **受控组件的值会被 React 覆写回去**：直接 `el.value = next` 是徒劳的，React 下次渲染会写回旧值。
 *    故统一走「原型上的原生 setter + 派发 input 事件」：原型 setter 绕过 React 在节点实例上包的
 *    value 存取器，随后的 input 事件让 onChange 读到新值。（execCommand('insertText') 在 jsdom 里
 *    不存在、新老 WebView2 行为不一，不用。）
 * 2) **点菜单项会夺焦**：菜单项是 <button>，mousedown 就把输入框焦点抢走，等 onClick 时已无焦点 ——
 *    没有落点、选区也读不到。故每个动作先按「打开菜单那一刻的选区」复原焦点与选区。
 */
import { t } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { copyText, readClipboardText } from '@/utils/clipboard'
import type { ContextMenuItem } from './index'

/** 菜单作用对象：项目里的可编辑控件只有这两种（没有 contenteditable） */
export type EditableElement = HTMLInputElement | HTMLTextAreaElement

/** 选区（起止都是码元下标，与 `selectionStart/End` 同源） */
interface Selection {
  start: number
  end: number
}

/** 读当前选区；不支持选区的控件（如 `type="number"`）一律当「无选区、光标在末尾」 */
function selectionOf(el: EditableElement): Selection {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  return { start, end }
}

/**
 * 把焦点与选区还给输入框。顺序不能反：先 focus() 再 setSelectionRange() —— 未聚焦时设的选区
 * 会在聚焦瞬间被浏览器自己的记忆覆盖。
 */
function focusWithSelection(el: EditableElement, sel: Selection): void {
  el.focus()
  try {
    el.setSelectionRange(sel.start, sel.end)
  } catch {
    // number / date 等不支持选区的类型：忽略，至少焦点回来了
  }
}

/**
 * 改写值：原生 setter（绕过 React 的变更追踪包装）+ `input` 事件（让 React 收到新值）。见文件头「坑 1」。
 * `caret` 要在派发事件之前摆好 —— 受控组件的 onChange 里常会顺手记 selectionStart，否则会记成默认位置。
 */
function replaceValue(el: EditableElement, next: string, caret: number): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, next)
  else el.value = next // 极端环境兜底：至少 DOM 是新的
  try {
    el.setSelectionRange(caret, caret)
  } catch {
    // 同 focusWithSelection：不支持选区的类型忽略
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * 输入框菜单项：剪切 / 复制 / 粘贴 / 全选。禁用态渲染时现算（无选区就没有可剪切 / 可复制的东西，
 * 与记事本一致）；传入 null（控件还没渲染）时全部禁用。「全选」保持菜单打开 —— 「右键 → 全选 →
 * 复制」是用户真实会做的连招。
 */
export function editableMenuItems(
  el: EditableElement | null,
): ContextMenuItem[] {
  // disabled 的控件连菜单都不该开（接线处已拦一道，这里再兜一层）
  const unavailable = !el || el.disabled
  // 只读控件能复制 / 全选，但不能改内容
  const canEdit = !unavailable && !el!.readOnly
  const { start, end } = el ? selectionOf(el) : { start: 0, end: 0 }
  const hasSelection = !unavailable && end > start
  const isEmpty = !el || el.value.length === 0

  return [
    {
      key: 'cut',
      label: t('剪切'),
      disabled: !canEdit || !hasSelection,
      onClick: async () => {
        const sel = selectionOf(el!)
        const text = el!.value.slice(sel.start, sel.end)
        if (!text) return
        const ok = await copyText(text)
        // 没写进剪贴板就别删 —— 否则这段文字直接从用户眼前消失了
        if (!ok) {
          showToast(t('复制失败'))
          return
        }
        focusWithSelection(el!, sel)
        replaceValue(
          el!,
          el!.value.slice(0, sel.start) + el!.value.slice(sel.end),
          sel.start,
        )
      },
    },
    {
      key: 'copy',
      label: t('复制'),
      disabled: !hasSelection,
      onClick: async () => {
        const sel = selectionOf(el!)
        // 先把焦点还回去，用户可以接着打字（复制不改内容，位置先复原更自然）
        focusWithSelection(el!, sel)
        const ok = await copyText(el!.value.slice(sel.start, sel.end))
        showToast(ok ? t('已复制到剪贴板') : t('复制失败'))
      },
    },
    {
      key: 'paste',
      label: t('粘贴'),
      disabled: !canEdit,
      onClick: async () => {
        const sel = selectionOf(el!)
        const text = await readClipboardText()
        // 读不到文本（剪贴板为空 / 是图片文件 / 无权限）→ 静默不动（与终端右键「粘贴」同一约定）；
        // 空串也说不清是哪种情况，弹提示只会误导人
        if (!text) return
        focusWithSelection(el!, sel)
        const { value } = el!
        replaceValue(
          el!,
          value.slice(0, sel.start) + text + value.slice(sel.end),
          sel.start + text.length,
        )
      },
    },
    {
      key: 'select-all',
      label: t('全选'),
      disabled: unavailable || isEmpty,
      // 全选后通常紧接着还要「复制」，菜单保持打开（与终端菜单同一约定）
      keepOpen: true,
      onClick: () => {
        el!.focus()
        el!.select()
      },
    },
  ]
}
