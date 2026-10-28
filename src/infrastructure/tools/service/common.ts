/**
 * service — 后台服务分类公共（id: service）。
 *
 * ⚠️ 本分类的四个工具**只有 Rust 原生实现**，前端不提供回退实现：
 * 服务的状态（进程、输出窗口、寿命）必须**只有一份**，放在 Rust 注册表里
 * （`virlen-core/src/agent/native_tools/service/registry.rs`）。前端再实现一份 = 两份状态要同步，
 * 必然分叉（AGENTS 铁律 1）。
 *
 * 占位执行器已抽到跨分类的 `../native-only.ts`（`mcp` 分类也用同一份）。
 */
export { nativeOnly } from '../native-only'
