import EventEmitter from '@/utils/EventEmitter'

type CommonEventType = {
  requestScrollToBottom: () => void
}
export default new EventEmitter<CommonEventType>()
