/**
 * InteractionEnded —— 「交互随**运行结束**被收敛」的标志错误（F4）。
 *
 * 与 `InteractionShelved`（用户点了暂存）同族，但语义不同：这次交互**没有被任何人回答**，
 * 而是运行结束了 —— 桌面点「停止」、手机取消 / 删除会话、引擎放弃这次交互请求。
 *
 * ⚠️ **为什么不直接复用 `'cancelled'`**：那等于告诉 AI「用户点了取消」，而真相是
 * 「这次提问从未被回答」。同 `services/rust-engine.ts` 里那条「桥接层不许静默消费」的纪律 ——
 * 让模型与排查者看到的是事实，而不是一个方便的近似。
 *
 * ⚠️ 判定按 `error.name`（与既有的 `InteractionShelved` 同一套做法）：桥接层在
 * `services/rust-engine.ts` 里**不需要 import 本模块**，也就不会产生
 * `services → services/tool-service` 的反向依赖。
 */
export class InteractionEnded extends Error {
  constructor(
    message: string = '交互随本次运行结束而被收敛（会话取消 / 删除 / 运行中止）',
  ) {
    super(message)
    this.name = 'InteractionEnded'
  }
}
