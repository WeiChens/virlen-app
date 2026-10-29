import UserChoiceMessage from './UserChoiceMessage'
import DefaultMessage from './DefaultMessage'
import WebFetchMessage from './WebFetchMessage'
import GetCurrentTimeMessage from './GetCurrentTimeMessage'
import ExecuteCommandMessage from './ExecuteCommandMessage'
import ExecuteScriptMessage from './ExecuteScriptMessage'
import EditFileMessage from './EditFileMessage'
import ReadFileMessage from './ReadFileMessage'
import SearchFileByNameMessage from './SearchFileByNameMessage'
import SearchTextInFileMessage from './SearchTextInFileMessage'
import ListFilesMessage from './ListFilesMessage'
import WriteFileMessage from './WriteFileMessage'
import DeleteFileMessage from './DeleteFileMessage'
import FileInfoMessage from './FileInfoMessage'
import { Message, ToolUseContent } from '@/types'
import VisionAnalyzeMessage from './VisionAnalyzeMessage'
import WebSearchMessage from './WebSearchMessage'
import CopyMoveFileMessage from './CopyMoveFileMessage'
import ListSkillsMessage from './ListSkillsMessage'
import ReadSkillSourceMessage from './ReadSkillSourceMessage'
import KnowledgeBaseMessage from './KnowledgeBaseMessage'
import MkdirMessage from './MkdirMessage'
import QueryMessagesMessage from './QueryMessagesMessage'
import TodoWriteMessage from './TodoWriteMessage'
import MemoryMessage from './MemoryMessage'
import BackgroundServiceMessage from './BackgroundServiceMessage'
import ParseDocumentMessage from './ParseDocumentMessage'
import PresentMessage from './PresentMessage'
import McpToolMessage from './McpToolMessage'
import McpResourceMessage from './McpResourceMessage'
import { isMcpToolName } from '@/domain/mcp/naming'

export interface IToolCallMessage {
  getToolName(): string
  getToolLabel(type: string): string
  getShortText(props: ToolMessageProps): React.ReactNode | string
  getExpandView(props: ToolMessageProps): React.ReactNode
  diyWrapper(): boolean
}
export interface ToolMessageProps {
  useContent: ToolUseContent
  /** 该工具调用的结果消息；工具尚在执行中时为 undefined（实现内统一用 props.message?. 访问） */
  message?: Message
  expand?: boolean
}

const toolCallMessageList = new Map<string, IToolCallMessage>()
function register(toolCallMessage: IToolCallMessage) {
  toolCallMessageList.set(toolCallMessage.getToolName(), toolCallMessage)
}
/** 注册一个消息组件到多个工具名（如知识库相关工具共享同一组件） */
function registerMulti(toolNames: string[], factory: () => IToolCallMessage) {
  for (const name of toolNames) {
    toolCallMessageList.set(name, factory())
  }
}
register(new DefaultMessage())
register(new UserChoiceMessage())
register(new WebFetchMessage())
register(new GetCurrentTimeMessage())
register(new ExecuteCommandMessage())
register(new ExecuteScriptMessage())
register(new EditFileMessage())
register(new WriteFileMessage())
register(new ReadFileMessage())
register(new SearchFileByNameMessage())
register(new SearchTextInFileMessage())
register(new ListFilesMessage())
register(new DeleteFileMessage())
register(new FileInfoMessage())
register(new VisionAnalyzeMessage())
register(new WebSearchMessage())
register(new CopyMoveFileMessage())
register(new ListSkillsMessage())
register(new ReadSkillSourceMessage())
register(new MkdirMessage())
register(new TodoWriteMessage())
registerMulti(
  [
    'search_knowledge_base',
    'list_knowledge_bases',
    'list_knowledge_base_documents',
    'get_knowledge_base_document',
    'write_to_knowledge_base',
    'delete_knowledge_base_document',
  ],
  () => new KnowledgeBaseMessage(),
)
registerMulti(
  ['list_messages', 'read_messages'],
  () => new QueryMessagesMessage(),
)
registerMulti(
  ['memory_search', 'memory_recall', 'memory_write'],
  () => new MemoryMessage(),
)
registerMulti(
  [
    'start_background_service',
    'get_background_service',
    'kill_background_service',
    'list_background_services',
  ],
  () => new BackgroundServiceMessage(),
)
register(new ParseDocumentMessage())
register(new PresentMessage())
registerMulti(
  ['list_mcp_resources', 'read_mcp_resource'],
  () => new McpResourceMessage(),
)

/** MCP 卡片无状态（不持有 props），一份实例足够 */
const mcpToolMessage = new McpToolMessage()

/**
 * 取工具卡片实现。
 *
 * ⚠️ MCP 工具**不能逐个注册**（名字由服务器在运行期决定），要靠「名称目录」兜底：
 * 目录由工具定义加载器写入（`setMcpToolCatalog`），`mcp__` 前缀只用于旧会话。
 * 其余名字仍精确匹配，未命中退 `DefaultMessage`。
 */
export const getToolCallMessage = (type: string) => {
  const registered = toolCallMessageList.get(type)
  if (registered) return registered
  if (isMcpToolName(type)) return mcpToolMessage
  return new DefaultMessage()
}
