import { debounce } from '@/utils/common'
import { action, makeObservable, observable } from 'mobx'

/**
 * 获取缓存值
 * @param defaultValue 获取失败的返回默认值
 * @param key 密钥
 * @returns
 */
const getLocal = <T>(
  defaultValue: T,
  key: string,
  storage = localStorage,
): T => {
  let data: T
  try {
    const str = storage.getItem(key)
    if (!str) {
      return defaultValue
    }
    data = JSON.parse(str)
    if (data == null) {
      return defaultValue
    }
  } catch (_: any) {
    data = defaultValue
  }
  return data
}
class StorageState<T extends object> {
  value: T
  private key: string
  private defaultValue: T
  private saveLocal: (data: T) => void
  private storage: Storage
  setValue<K extends keyof T>(key: K, value: T[K]) {
    this.value[key] = value
    this.saveLocal(this.value)
  }
  set(data: Partial<T>) {
    for (const key in data) {
      this.setValue(key as keyof T, data[key])
    }
  }
  clear() {
    this.value = this.defaultValue
    this.saveLocal(this.value)
  }
  /**
   *
   * @param key 缓存密钥
   * @param defaultValue 默认值
   * @param persistenceDelay 持久化延迟
   */
  constructor(
    key: string,
    defaultValue: T,
    persistenceDelay: number = 1000,
    storage = localStorage,
  ) {
    this.storage = storage
    if (defaultValue === null) {
      throw new Error('new StorageState param defaultValue cannot be null')
    }
    this.key = '_storage_state_' + key
    if (key.length < 5) {
      console.log('key too short, please use a longer key')
    }
    this.value = getLocal<T>(defaultValue, this.key, this.storage)
    this.defaultValue = defaultValue
    for (const key in defaultValue) {
      if (this.value[key] === undefined) {
        this.value[key] = defaultValue[key]
      }
    }
    if (persistenceDelay <= 0) {
      this.saveLocal = <T>(data: T) =>
        this.storage.setItem(this.key, JSON.stringify(data))
    } else {
      this.saveLocal = debounce(
        <T>(data: T) => this.storage.setItem(this.key, JSON.stringify(data)),
        persistenceDelay,
      )
    }

    makeObservable(this, {
      value: observable,
      setValue: action,
    })
  }

  /**
   * 扩展实例方法
   *
   * 将 obj 中的属性复制到当前实例上，返回类型为 StorageState<T> & M，
   * 调用方可直接访问 mixin 方法。
   *
   * @example
   * const state = new StorageState('key', defaultValue).mixins({
   *   getFoo() { return this.value.foo }
   * })
   * state.getFoo() // √ 类型安全
   */
  mixins<M extends Record<string, any>>(
    obj: M,
  ): StorageState<T> & M {
    Object.assign(this, obj)
    return this as unknown as StorageState<T> & M
  }
}
export default StorageState
