/**
 * 「忽略沙盒命令」规则的判定入口 —— Rust 原生路径的内部查询契约
 *
 * Rust 的 `execute_command` / `execute_script` 在执行前会发一个**内部交互**
 * （`type = "sandbox_rule_check"`，**无 UI、无审批**）问 JS：「这条命令命中规则了吗」。
 * 命中 → 免脱壳审批 + 强制以「不使用沙盒」方式执行（见 `native_tools/execute/common/rules.rs`）。
 *
 * 这里钉住两件容易被改坏的事：
 *  1. **应答格式**：必须是 JSON 字符串 `{"matched":bool,"ruleName":string|null}`
 *     （Rust 侧 `rules.rs::parse_rule_check` 按此解析）；
 *  2. **fail-closed**：空命令 / 未命中一律 `matched:false` —— 宁可退回沙盒执行，
 *     也不能因为解析不出结果就静默放行脱壳。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { runInAction } from 'mobx'
import { securityService } from '@/services/security-service'
import { toolService } from '@/services/tool-service'
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

describe('tool-service · sandbox_rule_check（Rust 原生路径的内部查询）', () => {
  it('命中 / 未命中 / 空命令都回 JSON 字符串（Rust 侧可解析）', async () => {
    securityStore.upsertSandboxRule(rule())
    const { handler, cleanup } = await toolService.createToolHandles('s1')

    const hitRes = await handler('sandbox_rule_check', {
      command: 'pnpm test',
      tool: 'execute_command',
    })
    expect(typeof hitRes).toBe('string')
    expect(JSON.parse(hitRes as string)).toEqual({
      matched: true,
      ruleName: '装依赖',
    })

    const missRes = await handler('sandbox_rule_check', {
      command: 'git status',
      tool: 'execute_command',
    })
    expect(JSON.parse(missRes as string)).toEqual({
      matched: false,
      ruleName: null,
    })

    // 空命令：不放行（matched:false）
    const emptyRes = await handler('sandbox_rule_check', { command: '' })
    expect(JSON.parse(emptyRes as string).matched).toBe(false)

    cleanup()
  })

  it('无规则时也照常应答（Rust 侧快照标志为 true 但规则刚被删掉）', async () => {
    const { handler, cleanup } = await toolService.createToolHandles('s2')
    const res = await handler('sandbox_rule_check', { command: 'pnpm test' })
    expect(JSON.parse(res as string)).toEqual({ matched: false, ruleName: null })
    cleanup()
  })
})
