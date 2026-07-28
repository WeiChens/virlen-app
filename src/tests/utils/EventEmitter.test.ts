/**
 * EventEmitter 测试 — 事件发布/订阅系统
 *
 * 覆盖场景：
 * - on/emit 基本的事件发布订阅
 * - once 一次性监听
 * - off 取消监听
 * - 多次 emit 和多个 listener
 * - once 监听器在 emit 后自动移除
 * - off 返回的取消函数
 * - 事件发射器 try-catch 不阻塞后续 listener
 * - 不同类型键的泛型支持
 * - 取消不存在的监听器不报错
 */
import { describe, it, expect, vi } from 'vitest'
import EventEmitter from '@/utils/EventEmitter'

describe('EventEmitter', () => {
  it('on() 注册监听器后 emit 应触发', () => {
    const emitter = new EventEmitter<{ test: (msg: string) => void }>()
    const spy = vi.fn()

    emitter.on('test', spy)
    emitter.emit('test', 'hello')

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith('hello')
  })

  it('多次 emit 应多次触发', () => {
    const emitter = new EventEmitter<{ count: (n: number) => void }>()
    const spy = vi.fn()

    emitter.on('count', spy)
    emitter.emit('count', 1)
    emitter.emit('count', 2)
    emitter.emit('count', 3)

    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenNthCalledWith(1, 1)
    expect(spy).toHaveBeenNthCalledWith(2, 2)
    expect(spy).toHaveBeenNthCalledWith(3, 3)
  })

  it('多个监听器应全部触发', () => {
    const emitter = new EventEmitter<{ event: (x: string) => void }>()
    const spy1 = vi.fn()
    const spy2 = vi.fn()

    emitter.on('event', spy1)
    emitter.on('event', spy2)
    emitter.emit('event', 'data')

    expect(spy1).toHaveBeenCalledOnce()
    expect(spy2).toHaveBeenCalledOnce()
  })

  it('once() 监听器只触发一次', () => {
    const emitter = new EventEmitter<{ click: () => void }>()
    const spy = vi.fn()

    emitter.once('click', spy)
    emitter.emit('click')
    emitter.emit('click')
    emitter.emit('click')

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('off() 应取消监听', () => {
    const emitter = new EventEmitter<{ msg: (s: string) => void }>()
    const spy = vi.fn()

    emitter.on('msg', spy)
    emitter.emit('msg', 'first')
    emitter.off('msg', spy)
    emitter.emit('msg', 'second')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('first')
  })

  it('on() 返回的取消函数应取消监听', () => {
    const emitter = new EventEmitter<{ test: () => void }>()
    const spy = vi.fn()

    const unsubscribe = emitter.on('test', spy)
    emitter.emit('test')
    unsubscribe()
    emitter.emit('test')

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('once() 返回的取消函数应取消监听（在触发前取消）', () => {
    const emitter = new EventEmitter<{ test: () => void }>()
    const spy = vi.fn()

    const unsubscribe = emitter.once('test', spy)
    unsubscribe()
    emitter.emit('test')

    expect(spy).not.toHaveBeenCalled()
  })

  it('未注册的事件 emit 不应报错', () => {
    const emitter = new EventEmitter<{ unknown: () => void }>()

    expect(() => emitter.emit('unknown')).not.toThrow()
  })

  it('取消不存在的监听器不应报错', () => {
    const emitter = new EventEmitter<{ test: () => void }>()
    const spy = vi.fn()

    expect(() => emitter.off('test', spy)).not.toThrow()
  })

  it('监听器中的异常不应阻塞其他监听器', () => {
    const emitter = new EventEmitter<{ test: () => void }>()
    const spy1 = vi.fn(() => { throw new Error('boom') })
    const spy2 = vi.fn()

    emitter.on('test', spy1)
    emitter.on('test', spy2)

    // 不应抛出异常
    expect(() => emitter.emit('test')).not.toThrow()
    expect(spy2).toHaveBeenCalledOnce()
  })

  it('once 监听器执行完后应从列表中移除', () => {
    const emitter = new EventEmitter<{ test: () => void }>()
    const spy = vi.fn()

    emitter.once('test', spy)
    emitter.emit('test')
    emitter.emit('test')

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('应支持 symbol 键', () => {
    const sym = Symbol('event')
    const emitter = new EventEmitter<{ [sym]: (x: number) => void }>()
    const spy = vi.fn()

    emitter.on(sym, spy)
    emitter.emit(sym, 42)

    expect(spy).toHaveBeenCalledWith(42)
  })

  it('应支持数字键', () => {
    const emitter = new EventEmitter<{ 0: (v: string) => void }>()
    const spy = vi.fn()

    emitter.on(0, spy)
    emitter.emit(0, 'zero')

    expect(spy).toHaveBeenCalledWith('zero')
  })
})
