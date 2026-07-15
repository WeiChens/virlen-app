/** 用户选择弹窗状态 */
import RuntimeState from '@/utils/runtimeState'

export interface UserChoiceState {
  /** 是否正在等待用户选择 */
  pending: boolean
  /** 关联的 tool call ID，回填结果时使用 */
  toolCallId: string
  /** 问题文本 */
  question: string
  /** 选项列表 */
  options: string[]
  /** 是否多选 */
  multi: boolean
  /** 等待时挂起的 resolve 回调，用户选择后调用 */
  resolver: ((selected: string | string[]) => void) | null
}

export const userChoiceState = new RuntimeState<UserChoiceState>({
  pending: false,
  toolCallId: '',
  question: '',
  options: [],
  multi: false,
  resolver: null,
})
