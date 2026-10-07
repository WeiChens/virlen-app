import { action, makeObservable, observable } from 'mobx'

class RuntimeState<T extends object> {
  value: T
  private defaultValue: T
  setValue<K extends keyof T>(key: K, value: T[K]) {
    this.value[key] = value
  }
  set(data: Partial<T>) {
    for (const key in data) {
      const value = data[key]
      // Partial 的字段可能显式为 undefined（等价于「未提供」），跳过避免写成空值
      if (value !== undefined) this.setValue(key, value)
    }
  }
  clear() {
    this.value = this.defaultValue
  }
  /**
   * @param defaultValue 默认值
   * @param option.shallow 是否用 observable.shallow
   */
  constructor(
    defaultValue: T,
    option?: {
      shallow?: boolean
    },
  ) {
    if (defaultValue === null) {
      throw new Error('new RuntimeState param defaultValue cannot be null')
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
   * 扩展实例方法：将 obj 属性复制到当前实例，返回 RuntimeState<T> & M（调用方直接访问 mixin 方法）。
   */
  mixins<M extends Record<string, any>>(
    obj: M,
  ): RuntimeState<T> & M {
    Object.assign(this, obj)
    return this as unknown as RuntimeState<T> & M
  }
}
export default RuntimeState
