/**
 * permission 领域模块单测 — 注册表 / 三态决策 / 旧枚举迁移
 *
 * 覆盖：权限 name 稳定、风险→权限映射、默认值与补全、严格度递进（deny 优先 + 脱壳权限取更严格者 +
 * 终端确认强制 ask）、旧 commandApprovalMode 到新权限表的迁移。与 Rust 侧决策语义对齐（铁律 1）。
 */
import { describe, it, expect } from 'vitest'
import {
  PERMISSIONS,
  PERM_SANDBOX_COMMAND,
  PERM_SANDBOX_SCRIPT,
  PERM_SCRIPT,
  PERM_TERMINAL_DANGEROUS,
  PERM_TERMINAL_INSTALL,
  PERM_TERMINAL_NORMAL,
  permissionForRisk,
  getPermissionDecision,
  withDefaultPermissions,
  permissionLabel,
  resolveCommandDecision,
  migrateApprovalMode,
} from '@/domain/permission'

describe('permission 注册表', () => {
  it('权限 name 唯一且稳定（跨 TS/Rust 契约）', () => {
    const names = PERMISSIONS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'terminal.normal.execute',
      'terminal.install.execute',
      'terminal.dangerous.execute',
      'script.execute',
      'sandbox.command.execute',
      'sandbox.script.execute',
    ])
  })

  it('风险分类 → 权限 name', () => {
    expect(permissionForRisk('safe')).toBe(PERM_TERMINAL_NORMAL)
    expect(permissionForRisk('install')).toBe(PERM_TERMINAL_INSTALL)
    expect(permissionForRisk('dangerous')).toBe(PERM_TERMINAL_DANGEROUS)
  })
})

describe('getPermissionDecision / withDefaultPermissions', () => {
  it('缺失回退注册表默认（正常命令 allow，其余 ask）', () => {
    expect(getPermissionDecision(undefined, PERM_TERMINAL_NORMAL)).toBe('allow')
    expect(getPermissionDecision({}, PERM_TERMINAL_INSTALL)).toBe('ask')
    expect(getPermissionDecision({}, PERM_TERMINAL_DANGEROUS)).toBe('ask')
    expect(getPermissionDecision({}, PERM_SCRIPT)).toBe('ask')
    expect(getPermissionDecision({}, PERM_SANDBOX_COMMAND)).toBe('ask')
    expect(getPermissionDecision({}, PERM_SANDBOX_SCRIPT)).toBe('ask')
  })

  it('非法值回退默认', () => {
    expect(
      getPermissionDecision({ [PERM_SCRIPT]: 'bogus' as any }, PERM_SCRIPT),
    ).toBe('ask')
  })

  it('withDefaultPermissions 补全所有权限项，且保留已设值', () => {
    const m = withDefaultPermissions({ [PERM_SCRIPT]: 'deny' })
    expect(Object.keys(m).sort()).toEqual(
      [...PERMISSIONS.map((p) => p.name)].sort(),
    )
    expect(m[PERM_SCRIPT]).toBe('deny')
    expect(m[PERM_TERMINAL_NORMAL]).toBe('allow')
  })
})

describe('resolveCommandDecision 严格度递进', () => {
  it('deny 永远优先（不被脱壳/终端确认放宽）', () => {
    expect(
      resolveCommandDecision('deny', {
        escapeDecision: 'allow',
        confirmTerminal: true,
      }),
    ).toBe('deny')
  })

  it('脱壳权限与基础决策取更严格者', () => {
    // 脱壳 ask（默认）→ 至少 ask
    expect(resolveCommandDecision('allow', { escapeDecision: 'ask' })).toBe(
      'ask',
    )
    // 脱壳 allow + 基础 allow → allow（静默脱壳）
    expect(resolveCommandDecision('allow', { escapeDecision: 'allow' })).toBe(
      'allow',
    )
    // 脱壳 allow 不能放宽更严格的基础
    expect(resolveCommandDecision('ask', { escapeDecision: 'allow' })).toBe(
      'ask',
    )
    // 脱壳 deny → 拒绝
    expect(resolveCommandDecision('allow', { escapeDecision: 'deny' })).toBe(
      'deny',
    )
  })

  it('终端内确认强制至少 ask；未申请脱壳时基础决策不变', () => {
    expect(resolveCommandDecision('allow', { confirmTerminal: true })).toBe(
      'ask',
    )
    expect(resolveCommandDecision('ask', {})).toBe('ask')
    expect(resolveCommandDecision('allow', {})).toBe('allow')
  })
})

describe('migrateApprovalMode 旧枚举迁移', () => {
  it('四种旧档位映射正确', () => {
    expect(migrateApprovalMode('all')).toMatchObject({
      [PERM_TERMINAL_NORMAL]: 'ask',
      [PERM_TERMINAL_INSTALL]: 'ask',
      [PERM_TERMINAL_DANGEROUS]: 'ask',
    })
    expect(migrateApprovalMode('risky')).toMatchObject({
      [PERM_TERMINAL_NORMAL]: 'allow',
      [PERM_TERMINAL_INSTALL]: 'allow',
      [PERM_TERMINAL_DANGEROUS]: 'ask',
    })
    expect(migrateApprovalMode('install')).toMatchObject({
      [PERM_TERMINAL_NORMAL]: 'allow',
      [PERM_TERMINAL_INSTALL]: 'ask',
      [PERM_TERMINAL_DANGEROUS]: 'ask',
    })
    expect(migrateApprovalMode('none')).toMatchObject({
      [PERM_TERMINAL_NORMAL]: 'allow',
      [PERM_TERMINAL_INSTALL]: 'allow',
      [PERM_TERMINAL_DANGEROUS]: 'allow',
    })
  })

  it('未知 / 空值 → null（新用户走注册表默认）', () => {
    expect(migrateApprovalMode(undefined)).toBeNull()
    expect(migrateApprovalMode('')).toBeNull()
    expect(migrateApprovalMode('xxx')).toBeNull()
  })

  it('脚本执行统一默认 ask（旧枚举无对应项）', () => {
    for (const m of ['all', 'risky', 'install', 'none']) {
      expect(migrateApprovalMode(m)![PERM_SCRIPT]).toBe('ask')
    }
  })
})

describe('permissionLabel', () => {
  it('返回中文名（i18n key），未知回退 name', () => {
    expect(permissionLabel(PERM_SCRIPT)).toBe('脚本命令执行')
    expect(permissionLabel(PERM_SANDBOX_COMMAND)).toBe('沙盒脱壳·命令执行')
    expect(permissionLabel(PERM_SANDBOX_SCRIPT)).toBe('沙盒脱壳·脚本执行')
    expect(permissionLabel('unknown.perm')).toBe('unknown.perm')
  })
})
