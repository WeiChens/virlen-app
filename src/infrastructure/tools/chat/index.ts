/**
 * chat — 会话消息分类（分类 id: chat）
 *
 * 一个工具一个文件，import 即完成注册（toolRegistry.register 副作用）。
 * 公共函数见 ./common.ts；分类定义见 src/domain/tools/category.ts。
 *
 * ⚠️ 这两个工具用于「查回被上下文压缩掉的历史消息」：
 *   - list_messages：取时序概览（seq + id + 摘要）
 *   - read_messages：按 id + 相对窗口读取正文
 * 二者只覆盖「已压缩区间」；深度思考绝不返回；工具详情一律截断。
 */
import './list-messages'
import './read-messages'
