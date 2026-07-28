/**
 * StorageState 测试 — 基于 localStorage 的状态管理
 *
 * 覆盖场景：
 * - 构造时从 localStorage 读取初始值
 * - setValue 更新单个字段并持久化
 * - set 批量更新多个字段
 * - clear 重置为默认值
 * - 默认值字段补全（当旧数据缺少新字段时）
 * - mixins 扩展实例方法
 * - persistenceDelay=0 时同步持久化
 * - key 太短时输出警告
 * - defaultValue 为 null 时抛异常
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// 需要在 StorageState 导入前替换 localStorage
const storage = new Map<string, string>()
const mockLocalStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
  removeItem: vi.fn((key: string) => { storage.delete(key) }),
  clear: vi.fn(() => { storage.clear() }),
  get length() { return storage.size },
  key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
}

// 在 import 前替换全局 localStorage
Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

import StorageState from '@/utils/storageState'

interface TestState {
  name: string
  count: number
  enabled: boolean
  tags: string[]
}

const DEFAULT_STATE: TestState = {
  name: 'default',
  count: 0,
  enabled: true,
  tags: [],
}

describe('StorageState', () => {
  beforeEach(() => {
    storage.clear()
    vi.clearAllMocks()
  })

  it('构造时应从 localStorage 读取初始值', () => {
    storage.set('_storage_state_test-key', JSON.stringify({ name: 'cached', count: 42 }))
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    expect(state.value.name).toBe('cached')
    expect(state.value.count).toBe(42)
    // enabled 和 tags 使用默认值
    expect(state.value.enabled).toBe(true)
    expect(state.value.tags).toEqual([])
  })

  it('localStorage 无数据时使用默认值', () => {
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    expect(state.value.name).toBe('default')
    expect(state.value.count).toBe(0)
    expect(state.value.enabled).toBe(true)
  })

  it('localStorage 数据损坏时使用默认值', () => {
    storage.set('_storage_state_test-key', '{invalid json}')
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    expect(state.value.name).toBe('default')
  })

  it('setValue 应更新指定字段并持久化', () => {
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    state.setValue('count', 99)
    expect(state.value.count).toBe(99)

    const saved = JSON.parse(storage.get('_storage_state_test-key')!)
    expect(saved.count).toBe(99)
  })

  it('set 应批量更新多个字段并持久化', () => {
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    state.set({ name: 'updated', count: 50 })
    expect(state.value.name).toBe('updated')
    expect(state.value.count).toBe(50)
    expect(state.value.enabled).toBe(true) // 未修改

    const saved = JSON.parse(storage.get('_storage_state_test-key')!)
    expect(saved.name).toBe('updated')
    expect(saved.count).toBe(50)
  })

  it('clear 应重置为默认值', () => {
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    state.setValue('name', 'changed')
    state.setValue('count', 999)
    state.clear()

    expect(state.value.name).toBe('default')
    expect(state.value.count).toBe(0)
    expect(state.value.enabled).toBe(true)
  })

  it('老数据缺少新字段时应自动补全默认值', () => {
    storage.set('_storage_state_test-key', JSON.stringify({ name: 'old' }))
    const state = new StorageState('test-key', DEFAULT_STATE, 0)
    // name 从缓存读取，其他字段补默认值
    expect(state.value.name).toBe('old')
    expect(state.value.count).toBe(0)
    expect(state.value.enabled).toBe(true)
    expect(state.value.tags).toEqual([])
  })

  it('mixins 应扩展实例方法', () => {
    const state = new StorageState('test-key', DEFAULT_STATE, 0).mixins({
      getDescription() {
        return `${this.value.name} (count: ${this.value.count})`
      },
    })
    state.setValue('name', 'test')
    state.setValue('count', 10)
    // @ts-ignore
    expect(state.getDescription()).toBe('test (count: 10)')
  })

  it('key 太短时应输出警告', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    new StorageState('ab', DEFAULT_STATE, 0)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('key too short'),
    )
    warnSpy.mockRestore()
  })

  it('defaultValue 为 null 时应抛异常', () => {
    expect(() => new StorageState('test', null as any, 0)).toThrow(
      'defaultValue cannot be null',
    )
  })

  it('persistenceDelay > 0 时应使用防抖持久化', () => {
    vi.useFakeTimers()
    const state = new StorageState('test-key', DEFAULT_STATE, 100)
    state.setValue('name', 'debounced')
    // 防抖期内不应写入 localStorage
    expect(mockLocalStorage.setItem).not.toHaveBeenCalledWith(
      '_storage_state_test-key',
      expect.any(String),
    )
    vi.advanceTimersByTime(100)
    // 防抖期后应写入
    expect(mockLocalStorage.setItem).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
