/**
 * securityStore — UI 层 Store
 *
 * 职责：
 *  - 持有 mobx observable，供 UI 组件响应式渲染
 *  - 数据读写委托给 SimpleRepo
 *
 * ⚠️ 不属于此 Store 的职责：
 *  - 业务规则校验 → 走 Application Service 或 Domain Port
 *  - 跨模块数据协调 → 走 Application Service
 */
import { action, makeObservable, observable } from 'mobx'
import type { SimpleRepo } from '@/infrastructure/repo'
import {
  securityRepo,
  SecurityConfig,
  defaultSecurityConfig,
} from '@/infrastructure/securityRepo'

class SecurityStore {
  value: SecurityConfig = { ...defaultSecurityConfig }

  constructor(private repo: SimpleRepo<SecurityConfig>) {
    this.value = { ...repo.load() }
    makeObservable(this, {
      value: observable,
      addToList: action,
      removeFromList: action,
    })
  }

  /** 持久化到 Repo */
  private persist(): void {
    this.repo.save(this.value)
  }

  /** 添加目录到列表（去重） */
  addToList(listName: keyof SecurityConfig, dirs: string[]): void {
    const current = [...this.value[listName]]
    let changed = false
    for (const dir of dirs) {
      const n = this.norm(dir)
      if (!(current as string[]).includes(n)) {
        ;(current as string[]).push(n)
        changed = true
      }
    }
    if (changed) {
      this.value = { ...this.value, [listName]: current as any }
      this.persist()
    }
  }

  addToWhitelist(dir: string): void {
    this.addToList('whitelist', [dir])
  }

  addToBlacklist(dir: string): void {
    this.addToList('blacklist', [dir])
  }

  addSkipEachDir(dir: string): void {
    this.addToList('skipEachDirs', [dir])
  }

  removeFromList(dir: string, listName: keyof SecurityConfig): void {
    const normalized = this.norm(dir)
    const current = [...(this.value[listName] as string[])]
    const idx = current.indexOf(normalized)
    if (idx !== -1) {
      current.splice(idx, 1)
      this.value = { ...this.value, [listName]: current as any }
      this.persist()
    }
  }

  removeSkipEachDir(dir: string): void {
    this.removeFromList(dir, 'skipEachDirs')
  }

  /** 路径格式统一为斜杠 */
  norm(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '')
  }
}

/** 全局单例 — UI 组件直接 import 使用 */
export const securityStore = new SecurityStore(securityRepo)
