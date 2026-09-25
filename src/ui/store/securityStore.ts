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
  hydrateSecurity,
} from '@/infrastructure/securityRepo'
import type { SandboxIgnoreRule } from '@/domain/security/sandbox-ignore-rules'
import {
  moveSandboxIgnoreRule,
  reorderSandboxIgnoreRule,
} from '@/domain/security/sandbox-ignore-rules'

class SecurityStore {
  value: SecurityConfig = { ...defaultSecurityConfig }

  constructor(private repo: SimpleRepo<SecurityConfig>) {
    this.value = { ...repo.load() }
    makeObservable(this, {
      value: observable,
      hydrate: action,
      addToList: action,
      removeFromList: action,
      upsertSandboxRule: action,
      removeSandboxRule: action,
      setSandboxRuleEnabled: action,
      moveSandboxRule: action,
      reorderSandboxRule: action,
    })
  }

  /** 持久化到 Repo */
  private persist(): void {
    this.repo.save(this.value)
  }

  /**
   * 配置下沉（S7）：从 Rust 侧 `app_settings` 水合「忽略沙盒命令」规则，并刷新本地镜像。
   *
   * 幂等；非 Tauri 环境（浏览器 dev / vitest）直接返回，仍用 localStorage 的值。
   * ⚠️ 必须在任何执行路径之前完成 —— Rust 引擎 / CLI 判定读的就是表里那一份。
   */
  async hydrate(): Promise<void> {
    await hydrateSecurity()
    this.value = { ...this.repo.load() }
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

  // ==================== 忽略沙盒命令规则 ====================

  /** 「忽略沙盒命令」规则列表（存量配置缺失时回退空数组） */
  get sandboxIgnoreRules(): SandboxIgnoreRule[] {
    return this.value.sandboxIgnoreRules ?? []
  }

  /** 新增 / 覆盖一条规则（id 命中则替换，否则追加到末尾） */
  upsertSandboxRule(rule: SandboxIgnoreRule): void {
    const rules = [...this.sandboxIgnoreRules]
    const idx = rules.findIndex((r) => r.id === rule.id)
    if (idx === -1) {
      rules.push(rule)
    } else {
      rules[idx] = rule
    }
    this.setSandboxRules(rules)
  }

  /** 删除一条规则 */
  removeSandboxRule(id: string): void {
    this.setSandboxRules(this.sandboxIgnoreRules.filter((r) => r.id !== id))
  }

  /** 启用 / 禁用一条规则（禁用后不参与匹配） */
  setSandboxRuleEnabled(id: string, enabled: boolean): void {
    this.setSandboxRules(
      this.sandboxIgnoreRules.map((r) => (r.id === id ? { ...r, enabled } : r)),
    )
  }

  /**
   * 上移 / 下移一条规则（`offset` 为 -1 / +1）。
   *
   * 列表顺序即匹配优先级，所以在 UI 上是可操作项而不是展示顺序；
   * 越界时领域函数返回同一个数组引用 —— 直接跳过落库，避免无意义的写入。
   */
  moveSandboxRule(id: string, offset: number): void {
    const next = moveSandboxIgnoreRule(this.sandboxIgnoreRules, id, offset)
    if (next === this.sandboxIgnoreRules) return
    this.setSandboxRules(next)
  }

  /**
   * 拖拽排序：把规则移到第 `targetIndex` 个间隙（0..n）。
   *
   * 与 `moveSandboxRule`（相邻一位，键盘方向键用）共用同一套「越界不落库」约定。
   */
  reorderSandboxRule(id: string, targetIndex: number): void {
    const next = reorderSandboxIgnoreRule(
      this.sandboxIgnoreRules,
      id,
      targetIndex,
    )
    if (next === this.sandboxIgnoreRules) return
    this.setSandboxRules(next)
  }

  /** 写回规则列表（新对象引用 → 触发持久化 + 重渲染） */
  private setSandboxRules(rules: SandboxIgnoreRule[]): void {
    this.value = { ...this.value, sandboxIgnoreRules: rules }
    this.persist()
  }

  /** 路径格式统一为斜杠 */
  norm(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '')
  }
}

/** 全局单例 — UI 组件直接 import 使用 */
export const securityStore = new SecurityStore(securityRepo)
