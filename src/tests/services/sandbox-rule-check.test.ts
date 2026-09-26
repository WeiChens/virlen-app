/**
 * 「忽略沙盒命令」规则的判定（**TS 侧实现**）
 *
 * ⚠️ S7 之后默认引擎（Rust）与 CLI 的判定不再走这里：规则随 `NativeToolSecurity` 下发、
 * 在 Rust 侧本地求值（`virlen-core/src/security/`），跨桥的 `sandbox_rule_check` 已删除。
 * 本文件钉的是仍保留 TS 实现的那条路径（`securityService.matchSandboxIgnoreRule`：
 * 浏览器 dev / 设置页「测试」）：
 *  1. 命中 / 未命中 / 空命令的语义；
 *  2. fail-closed：禁用中的规则、非法的正则 / JS 一律按「未命中」处理
 *     （宁可退回沙盒执行，也不静默放行脱壳）。
 *
 * 与 Rust 侧的一致性由两侧**共读**的 golden 保证：
 *   `src/tests/fixtures/sandbox-rules.golden.json`（另见 `sandbox-rules-golden.test.ts`）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { runInAction } from 'mobx'
import { securityService } from '@/services/security-service'
import { securityStore } from '@/ui/store/securityStore'
import {
  createSandboxIgnoreRule,
  type SandboxIgnoreRule,
} from '@/domain/security/sandbox-ignore-rules'

const STORAGE_KEY = 'virlen-security'

/** 一条「前缀匹配 pnpm」的简单规则 */
function rule(patch: Partial<SandboxIgnoreRule> = {}): SandboxIgnoreRule {
  return createSandboxIgnoreRule({
    name: '装依赖',
    kind: 'text',
    textMode: 'prefix',
    pattern: 'pnpm',
    ...patch,
  })
}

beforeEach(() => {
  // 清掉上一个用例留下的规则（store 与 repo 一起清，避免两条读取路径不一致）
  localStorage.removeItem(STORAGE_KEY)
  runInAction(() => {
    securityStore.value = {
      whitelist: [],
      blacklist: [],
      skipEachDirs: [],
      sandboxIgnoreRules: [],
    }
  })
})

describe('securityService.matchSandboxIgnoreRule', () => {
  it('命中启用中的规则', async () => {
    securityStore.upsertSandboxRule(rule())
    const hit = await securityService.matchSandboxIgnoreRule('pnpm install')
    expect(hit?.name).toBe('装依赖')
  })

  it('未命中 / 空命令 / 仅空白 → null', async () => {
    securityStore.upsertSandboxRule(rule())
    expect(await securityService.matchSandboxIgnoreRule('git status')).toBeNull()
    expect(await securityService.matchSandboxIgnoreRule('')).toBeNull()
    expect(await securityService.matchSandboxIgnoreRule('   ')).toBeNull()
  })

  it('禁用的规则不参与匹配，且非法规则内容不会抛错', async () => {
    securityStore.upsertSandboxRule(rule({ enabled: false }))
    expect(await securityService.matchSandboxIgnoreRule('pnpm install')).toBeNull()

    securityStore.upsertSandboxRule(rule({ kind: 'regex', pattern: '([unclosed' }))
    // 非法正则 → 匹配器内部按「未命中」处理
    expect(await securityService.matchSandboxIgnoreRule('pnpm install')).toBeNull()
  })
})

