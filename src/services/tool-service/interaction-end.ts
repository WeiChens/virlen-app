/**
 * InteractionEnded —— 「交互随**运行结束**被收敛」的标志错误（F4）。
 *
 * 与 `InteractionShelved`（用户点了暂存）同族但语义不同：这次交互**没被任何人回答**，
 * 而是运行结束了（桌面停止 / 手机取消或删除会话 / 引擎放弃请求）。
 *
 * ⚠️ 不复用 `'cancelled'`：那等于谎称「用户点了取消」，而真相是「这次提问从未被回答」——
 * 让模型与排查者看到事实，而不是方便的近似。
 * ⚠️ 判定按 `error.name`，桥接层（services/rust-engine.ts）无需 import 本模块，避免反向依赖。
 */
export class InteractionEnded extends Error {
  constructor(
    message: string = '交互随本次运行结束而被收敛（会话取消 / 删除 / 运行中止）',
  ) {
    super(message)
    this.name = 'InteractionEnded'
  }
}
