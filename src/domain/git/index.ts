/**
 * git 领域层 Barrel。
 *
 * `group.ts` 是**分组 / 徽标口径的唯一实现**（纯函数，界面与测试都消费它）；
 * `graph.ts` 是**提交图口径的唯一实现**（列分配 / 配色 / 绘制指令 —— 几何不给 canvas 组件）；
 * `types.ts` 与 Rust 的 serde 结构逐字对应。
 */
export * from './types'
export * from './group'
export * from './diff-rows'
export * from './graph'
