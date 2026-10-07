/**
 * knowledge-base — 知识库分类（id: knowledge_base）；import 即注册（见 domain/tools/category.ts）。
 * AI 自主决定何时使用这些工具，引擎不会自动注入 RAG 上下文。
 */
import './search-knowledge-base'
import './list-knowledge-bases'
import './list-knowledge-base-documents'
import './get-knowledge-base-document'
import './write-to-knowledge-base'
import './delete-knowledge-base-document'
