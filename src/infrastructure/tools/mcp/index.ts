/**
 * mcp — MCP 资源分类（id: mcp）；import 即注册（见 domain/tools/category.ts）。
 *
 * 两个工具查的是**外部 MCP 服务器**声明的资源（`resources/list` / `resources/read`），
 * 执行全在 Rust（`virlen-core/src/agent/native_tools/mcp/`）；前端只登记占位执行器。
 * 动态的 `mcp__<server>__<tool>` 工具**不在**这个分类里 —— 它们是运行期定义，由设置页决定。
 */
import './list-resources'
import './read-resource'
