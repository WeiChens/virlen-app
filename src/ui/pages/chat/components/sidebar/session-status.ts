/**
 * 侧边栏状态槽「放哪一枚」的判定（纯函数，可单测）。
 *
 * 一个会话（或一个折叠分组）可能同时「在忙」和「有交互等你回答」—— 两枚点并排既挤又互相拆台
 * （一枚说「在跑」、一枚说「卡住」）。所以槽里只放一枚，**等你回答优先**：
 * 引擎等你作答时 run 仍算在忙，而琥珀点是「它已经停下、只等你动手」的唯一信号，不能被挤掉。
 */
export type StatusFlagKind = 'waiting' | 'busy'

export function statusFlagKind(
  waiting: boolean,
  busy: boolean,
): StatusFlagKind | null {
  if (waiting) return 'waiting'
  if (busy) return 'busy'
  return null
}
