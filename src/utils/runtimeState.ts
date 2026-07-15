import { action, makeObservable, observable } from 'mobx'

class RuntimeState<T extends object> {
  value: T
  private defaultValue: T
  setValue<K extends keyof T>(key: K, value: T[K]) {
    this.value[key] = value
  }
  set(data: Partial<T>) {
    for (const key in data) {
      this.setValue(key as keyof T, data[key])
    }
  }
  clear() {
    this.value = this.defaultValue
  }
  /**
   *
   * @param key 缓存密钥
   * @param defaultValue 默认值
   * @param persistenceDelay 持久化延迟
   */
  constructor(
    defaultValue: T,
    option?: {
      shallow?: boolean
    },
  ) {
    if (defaultValue === null) {
      throw new Error('new StorageState param defaultValue cannot be null')
    }
    this.value = defaultValue
    this.defaultValue = defaultValue
    for (const key in defaultValue) {
      if (this.value[key] === undefined) {
        this.value[key] = defaultValue[key]
      }
    }
    makeObservable(this, {
      value: option?.shallow ? observable.shallow : observable,
      setValue: action,
    })
  }

  /**
   * 扩展实例方法
   *
   * 将 obj 中的属性复制到当前实例上，返回类型为 RuntimeState<T> & M，
   * 调用方可直接访问 mixin 方法。
   */
  mixins<M extends Record<string, any>>(
    obj: M,
  ): RuntimeState<T> & M {
    Object.assign(this, obj)
    return this as unknown as RuntimeState<T> & M
  }
}
export default RuntimeState
