import UserChoiceMessage from './UserChoiceMessage'
import DefaultMessage from './DefaultMessage'
import WebFetchMessage from './WebFetchMessage'
import GetCurrentTimeMessage from './GetCurrentTimeMessage'
import ExecuteCommandMessage from './ExecuteCommandMessage'
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
import KnowledgeBaseMessage from './KnowledgeBaseMessage'

export interface IToolCallMessage {
  getToolName(): string
  getToolLabel(type: string): string
  getShortText(props: ToolMessageProps): React.ReactNode | string
  getExpandView(props: ToolMessageProps): React.ReactNode
  diyWrapper(): boolean
}
export interface ToolMessageProps {
  useContent: ToolUseContent
  message: Message
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

export const getToolCallMessage = (type: string) => {
  return toolCallMessageList.get(type) || new DefaultMessage()
}
