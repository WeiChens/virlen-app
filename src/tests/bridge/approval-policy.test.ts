/**
 * approval-policy —— 审批分级的**契约测试**（docs/phone-control-bridge.md §16.2）。
 *
 * 这个文件只守一件事：`KNOWN_PERMS` 必须与 `domain/permission` 的注册表**完全一致**。
 * 为什么值得单独守：分级策略对「未知权限」是**从严**的（`high` + 审计理由「未知权限」），
 * 所以漏登记不会报错、只会让新权限悄悄多一次手机侧二次确认 —— 曾经就这样漏掉过
 * `terminal.background.execute`（加权限时要改 Rust `classify.rs` + TS 注册表 + 本文件三处）。
 *
 * 其余用例锁住「哪些因素会把一次授权抬成高风险」的既有口径，避免以后调分级时改坏降级方向。
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_PERMS, classifyApproval } from '@/bridge/approval-policy'
import { PERMISSIONS } from '@/domain/permission'

const registryNames = PERMISSIONS.map((p) => p.name)

describe('approval-policy 与权限注册表对齐', () => {
  it('注册表里的每个权限都登记在 KNOWN_PERMS（漏登记 = 手机侧静默从严）', () => {
    const missing = registryNames.filter((name) => !KNOWN_PERMS.has(name))
    expect(missing, `这些权限没登记进 KNOWN_PERMS：${missing.join(', ')}`).toEqual([])
  })

  it('KNOWN_PERMS 里没有注册表之外的名字（删权限时要一起清）', () => {
    const stale = [...KNOWN_PERMS].filter((name) => !registryNames.includes(name))
    expect(stale, `这些名字已不在权限注册表里：${stale.join(', ')}`).toEqual([])
  })
})

describe('classifyApproval 分级口径', () => {
  const background = 'terminal.background.execute'

  it('AI 提问不是安全边界 → 不设摩擦', () => {
    expect(classifyApproval({ kind: 'choice' }).tier).toBe('low')
  })

  it('后台服务启动：普通命令风险 → 低摩擦（与普通终端命令同档）', () => {
    expect(
      classifyApproval({
        kind: 'authorization',
        permName: background,
        risk: 'safe',
      }),
    ).toEqual({ tier: 'low', reason: background })
  })

  it('后台服务启动：申请脱壳 / 危险命令 → 恒高风险（两条各自成立）', () => {
    expect(
      classifyApproval({
        kind: 'authorization',
        permName: background,
        risk: 'safe',
        sandboxBypass: true,
      }).tier,
    ).toBe('high')
    expect(
      classifyApproval({
        kind: 'authorization',
        permName: background,
        risk: 'dangerous',
      }).tier,
    ).toBe('high')
  })

  it('终端内确认：手机只能原样放行 → 高风险', () => {
    expect(
      classifyApproval({
        kind: 'authorization',
        permName: background,
        risk: 'safe',
        presentation: 'terminal',
      }).tier,
    ).toBe('high')
  })

  it('未知权限 / 缺权限标识 → 从严（fail-closed）', () => {
    expect(
      classifyApproval({
        kind: 'authorization',
        permName: 'terminal.brand.new.execute',
        risk: 'safe',
      }),
    ).toEqual({ tier: 'high', reason: '未知权限（从严）：terminal.brand.new.execute' })
    expect(classifyApproval({ kind: 'authorization', risk: 'safe' })).toEqual({
      tier: 'high',
      reason: '缺少权限标识（从严）',
    })
  })

  it('恒高风险权限与风险等级无关（脱壳 / 脚本 / 危险命令）', () => {
    for (const perm of [
      'terminal.dangerous.execute',
      'script.execute',
      'sandbox.command.execute',
      'sandbox.script.execute',
    ]) {
      expect(
        classifyApproval({ kind: 'authorization', permName: perm, risk: 'safe' }),
      ).toEqual({ tier: 'high', reason: `高危权限：${perm}` })
    }
  })
})
