import EventEmitter from '@/utils/EventEmitter'

type SettingsEventType = {
  /** 打开设置面板，跳转到指定页面 */
  openSettings: (page: string) => void
}

export default new EventEmitter<SettingsEventType>()
