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

export const getToolCallMessage = (type: string) => {
  return toolCallMessageList.get(type) || new DefaultMessage()
}
