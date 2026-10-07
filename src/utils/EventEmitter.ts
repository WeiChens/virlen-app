/** 任意函数 */
type WhateverFunc = (...args: any[]) => any
/** key 只能是函数类型 */
interface EventType {
  [key: string]: WhateverFunc
  [numberKey: number]: WhateverFunc
  [SymbolKey: symbol]: WhateverFunc
}

interface EventItem {
  fn: WhateverFunc
  once: boolean
}
class EventEmitter<T extends EventType> {
  private events: Map<keyof T, EventItem[]> = new Map()
  /** 事件监听；返回取消函数 */
  on<K extends keyof T>(key: K, fn: T[K]) {
    this._on(key, fn, false)
    return () => {
      this.off(key, fn)
    }
  }
  /** 事件监听（只触发一次）；返回取消函数 */
  once<K extends keyof T>(key: K, fn: T[K]) {
    this._on(key, fn, true)
    return () => {
      this.off(key, fn)
    }
  }
  private _on<K extends keyof T>(key: K, fn: T[K], once: boolean) {
    let item = this.events.get(key)
    if (item) {
      item.push({
        fn,
        once,
      })
      return
    }
    this.events.set(key, [
      {
        fn,
        once,
      },
    ])
  }
  /** 事件发布 */
  emit<K extends keyof T>(key: K, ...args: Parameters<T[K]>) {
    let list = this.events.get(key)
    if (!list) return
    list.forEach((item) => {
      // 加个try防止报错堵塞
      try {
        item.fn(...args)
      } catch (e) {
        console.error(e)
      }
    })
    list = list.filter((item) => !item.once)
    this.events.set(key, list)
  }
  /** 取消监听 */
  off<K extends keyof T>(key: K, fn: T[K]) {
    let list = this.events.get(key)
    if (!list) return
    list = list.filter((item) => item.fn !== fn)
    this.events.set(key, list)
  }
}

export default EventEmitter
