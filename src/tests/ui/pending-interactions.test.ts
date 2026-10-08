/**
 * 待应答交互的**队列状态机**（`modals/pending-interactions.ts`）纯函数用例。
 *
 * 为什么守这一层：「一次只展示一个弹窗 / 新来的不抢焦点 / 应答后轮到谁」全在这里决定，
 * 组件只负责摆 HTML。判错的方向都很难看：
 *  - 抢了焦点 → 用户正在填的弹窗被顶掉（改造前的「覆盖」）；
 *  - 移除时不接管原位 → 答完一个突然跳到不相干的一项；
 *  - 未读标记不清 → 切换条上一直挂着小红点。
 */
import { describe, expect, it } from 'vitest'
import {
  activate,
  activeItem,
  enqueue,
  pendingLabel,
  questionSummary,
  removePending,
  stepPending,
  EMPTY_PENDING_STATE,
  type PendingInteraction,
  type PendingState,
} from '@/ui/pages/chat/components/modals/pending-interactions'

/** 两个分支各自的精确类型（spread 时保留字段，便于改 title / permName 等） */
type ChoiceItem = Extract<PendingInteraction, { kind: 'choice' }>
type AuthItem = Extract<PendingInteraction, { kind: 'authorization' }>

const choice = (id: string, question = '要继续吗？'): ChoiceItem => ({
  kind: 'choice',
  interactionId: id,
  sessionId: 's1',
  toolCallId: `tc-${id}`,
  question,
  options: ['继续', '停下'],
  multi: false,
} satisfies ChoiceItem)

const auth = (id: string, title = '执行终端命令'): AuthItem => ({
  kind: 'authorization',
  interactionId: id,
  sessionId: 's1',
  toolCallId: `tc-${id}`,
  permName: 'terminal.normal.execute',
  title,
} satisfies AuthItem)

/** 依次入队（模拟事件到达顺序） */
function withItems(...items: PendingInteraction[]): PendingState {
  return items.reduce((s, item) => enqueue(s, item), EMPTY_PENDING_STATE)
}

describe('enqueue / activeItem：一次只展示一个，新来的不抢焦点', () => {
  it('空队列：第一个到达的立刻展示（否则没人看得见它）', () => {
    const s = enqueue(EMPTY_PENDING_STATE, choice('a'))
    expect(activeItem(s)?.interactionId).toBe('a')
    // 立刻可见 → 不该带未读点
    expect(s.unread).toEqual([])
  })

  it('已有展示项：新来的排队，不改展示项、标未读（不打断用户正在填的那个）', () => {
    const s = enqueue(withItems(choice('a')), auth('b'))
    expect(activeItem(s)?.interactionId).toBe('a')
    expect(s.items.map((i) => i.interactionId)).toEqual(['a', 'b'])
    expect(s.unread).toEqual(['b'])
    // 类型混排也要保持到达顺序（切换条上的序号就是它）
    expect(s.items.map((i) => i.kind)).toEqual(['choice', 'authorization'])
  })

  it('同一个 interactionId 重复入队 → 幂等（事件重放 / 两个应答端都收到）', () => {
    const first = withItems(choice('a'))
    expect(enqueue(first, choice('a'))).toBe(first)
  })

  it('activeId 失效（没被 remove 覆盖到的历史状态）→ 退回队首，保证「有队列就有弹窗」', () => {
    const s: PendingState = {
      items: [choice('a'), auth('b')],
      activeId: 'ghost',
      unread: [],
    }
    expect(activeItem(s)?.interactionId).toBe('a')
    expect(activeItem(EMPTY_PENDING_STATE)).toBeNull()
  })
})

describe('removePending：应答 / 过期出队，落到原位置的相邻项', () => {
  it('移除当前项 → 接管它原来的位置（下一个）；接手项清掉未读点', () => {
    const s = withItems(choice('a'), auth('b'), choice('c'))
    const next = removePending(s, 'a')
    expect(next.items.map((i) => i.interactionId)).toEqual(['b', 'c'])
    expect(next.activeId).toBe('b')
    // b 立刻可见 → 未读点清掉；c 仍待读
    expect(next.unread).toEqual(['c'])
  })

  it('移除当前项且它已是末尾 → 回退到上一个（不跳到队首）', () => {
    const s = withItems(choice('a'), auth('b'), choice('c'))
    const next = removePending(activate(s, 'c'), 'c')
    expect(next.activeId).toBe('b')
  })

  it('移除的是后台项（用户在切换条上切到了别的）→ 展示项不变', () => {
    const s = activate(withItems(choice('a'), auth('b')), 'b')
    const next = removePending(s, 'a')
    expect(next.items.map((i) => i.interactionId)).toEqual(['b'])
    expect(next.activeId).toBe('b')
  })

  it('移除最后一项 → 队列空、无展示项、无未读', () => {
    const next = removePending(withItems(choice('a')), 'a')
    expect(next.items).toEqual([])
    expect(next.activeId).toBeNull()
    expect(next.unread).toEqual([])
    expect(activeItem(next)).toBeNull()
  })

  it('不存在的 id → 原样返回同一个引用（避免无意义重渲染）', () => {
    const s = withItems(choice('a'))
    expect(removePending(s, 'ghost')).toBe(s)
  })
})

describe('activate / stepPending：切换（点击与 Alt+←→ 共用同一套状态）', () => {
  it('切到指定项 → 成为展示项且清掉未读', () => {
    const s = withItems(choice('a'), auth('b'))
    const next = activate(s, 'b')
    expect(next.activeId).toBe('b')
    expect(next.unread).toEqual([])
  })

  it('已是当前项且无未读 / 目标不存在 → 原样返回同一个引用', () => {
    const s = activate(withItems(choice('a'), auth('b')), 'b')
    expect(activate(s, 'b')).toBe(s)
    expect(activate(s, 'ghost')).toBe(s)
  })

  it('stepPending：环形前进 / 后退', () => {
    const s = withItems(choice('a'), auth('b'), choice('c'))
    expect(stepPending(s, 1, 'a').activeId).toBe('b')
    expect(stepPending(s, 1, 'c').activeId).toBe('a') // 末尾 → 回绕到队首
    expect(stepPending(s, -1, 'a').activeId).toBe('c')
    // 只有一项时不动（快捷键此时也不该装监听）
    expect(stepPending(withItems(choice('a')), 1, 'a').activeId).toBe('a')
  })

  it('stepPending：currentId 不在队列里（或为 null）→ 前进取队首、后退取队尾', () => {
    const s = withItems(choice('a'), auth('b'))
    expect(stepPending(s, 1, null).activeId).toBe('a')
    expect(stepPending(s, -1, null).activeId).toBe('b')
    expect(stepPending(s, 1, 'ghost').activeId).toBe('a')
  })
})

describe('questionSummary / pendingLabel：切换条上的一行标签', () => {
  it('剥掉代码块与行内标记、压缩空白、超长截断', () => {
    expect(questionSummary('  继续\n还是  停下？ ')).toBe('继续 还是 停下？')
    expect(questionSummary('# 标题\n**加粗** 与 `代码`')).toBe('标题 加粗 与 代码')
    expect(questionSummary('先看\n```ts\nconst a = 1\n```\n再答')).toBe('先看 再答')
    const long = questionSummary('一'.repeat(50))
    expect(long.length).toBe(37) // 36 + 省略号
    expect(long.endsWith('…')).toBe(true)
  })

  it('授权取权限标题；没标题退回权限 key', () => {
    expect(pendingLabel(auth('a', '执行终端命令'))).toBe('执行终端命令')
    expect(
      pendingLabel({ ...auth('a'), title: '', permName: 'shell.run' }),
    ).toBe('shell.run')
    expect(pendingLabel(choice('a', '用哪个方案？'))).toBe('用哪个方案？')
  })
})
