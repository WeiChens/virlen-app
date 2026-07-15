import EventEmitter from '@/utils/EventEmitter'

type MenuEventType = {
  showAboutModal: () => void
}
export default new EventEmitter<MenuEventType>()
