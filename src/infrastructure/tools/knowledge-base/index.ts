/**
 * knowledge-base — 知识库分类（分类 id: knowledge_base）
 *
 * 一个工具一个文件，import 即完成注册（toolRegistry.register 副作用）。
 * 公共函数见 ./common.ts；分类定义见 src/domain/tools/category.ts。
 *
 * ⚠️ AI 自主决定何时使用这些工具，引擎不会自动注入 RAG 上下文。
 */
import './search-knowledge-base'
import './list-knowledge-bases'
import './list-knowledge-base-documents'
import './get-knowledge-base-document'
import './write-to-knowledge-base'
import './delete-knowledge-base-document'
