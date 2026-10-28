/**
 * MCP 领域层（纯逻辑，无 I/O）。
 *
 * ```text
 * domain/mcp/
 * ├── types.ts   McpServerConfig / McpServerStatus / McpToolInfo（与 Rust serde 同形）
 * ├── naming.ts  公开名解析（只解析不生成 —— 生成在 Rust）
 * └── config.ts  默认值 / 校验 / 文本框互转
 * ```
 */
export * from './types'
export * from './naming'
export * from './config'
