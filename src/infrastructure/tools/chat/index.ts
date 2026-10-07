/**
 * chat — 会话消息分类（id: chat）；import 即注册（见 domain/tools/category.ts）。
 * 用于查回被上下文压缩掉的历史：list_messages（seq + id + 摘要）/ read_messages（按 id + 窗口读正文）；
 * 只覆盖「已压缩区间」，深度思考绝不返回，工具详情一律截断。
 */
import './list-messages'
import './read-messages'
