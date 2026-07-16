/**
 * updateEvent — 更新检查事件的发布/订阅
 *
 * 用于在 main.ts 初始化完成后触发更新检查弹窗。
 */
import EventEmitter from '@/utils/EventEmitter'
import type { ICheckUpdateResponse } from '@/types'

type UpdateEvent = {
  /** 显示更新弹窗 */
  showUpdateModal: (updateInfo: ICheckUpdateResponse) => void
}

const updateEvent = new EventEmitter<UpdateEvent>()

export default updateEvent
