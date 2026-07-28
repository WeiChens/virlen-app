/**
 * Security 端口测试 — 路径安全校验逻辑
 *
 * 覆盖场景：
 * - 黑名单优先级最高，匹配黑名单 → 拦截
 * - 白名单优先级高于工作目录
 * - 工作目录内的路径允许访问
 * - 写模式下，非白名单/工作目录路径 → 拦截
 * - 读模式下，非白名单/工作目录路径 → 放行
 * - 路径无法解析 → 拦截
 * - 黑名单子路径匹配
 * - 白名单子路径匹配
 * - 默认黑名单的跨平台配置
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock pathCanonicealize 工具
const { mockTryCanonicalize, mockTryCanonicalizePartial } = vi.hoisted(() => ({
  mockTryCanonicalize: vi.fn(),
  mockTryCanonicalizePartial: vi.fn(),
}))

vi.mock('@/utils/pathCanonicealize', () => ({
  tryCanonicalize: mockTryCanonicalize,
  tryCanonicalizePartial: mockTryCanonicalizePartial,
}))

import { securityPort } from '@/domain/security'

describe('SecurityPort — isPathAllowed', () => {
  const workspace = '/home/user/project'
  const blacklist = ['/etc/shadow', '/home/user/.ssh']
  const whitelist = ['/home/user/project/tmp']

  beforeEach(() => {
    vi.clearAllMocks()
    // 默认：tryCanonicalizePartial 返回原路径（模拟路径存在）
    mockTryCanonicalizePartial.mockImplementation(async (path: string) => {
      if (!path) return null
      return path.replace(/\\/g, '/').replace(/\/+$/, '')
    })
    // 默认：tryCanonicalize 返回原路径
    mockTryCanonicalize.mockImplementation(async (path: string) => {
      if (!path) return null
      return path.replace(/\\/g, '/').replace(/\/+$/, '')
    })
  })

  describe('黑名单拦截', () => {
    it('应拦截黑名单中的精确路径', async () => {
      const result = await securityPort.isPathAllowed(
        '/etc/shadow',
        'r',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('黑名单')
    })

    it('应拦截黑名单路径的子路径', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/.ssh/id_rsa',
        'r',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(false)
    })

    it('黑名单中不匹配的路径应放行', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/project/src/main.ts',
        'r',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(true)
    })
  })

  describe('白名单放行', () => {
    it('应放行白名单中的路径', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/project/tmp/cache.dat',
        'w',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(true)
    })

    it('白名单优先级高于写模式拦截', async () => {
      // 路径不在工作目录但在白名单内
      const result = await securityPort.isPathAllowed(
        '/home/user/project/tmp',
        'w',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(true)
    })
  })

  describe('工作目录放行', () => {
    it('应放行工作目录内的路径（读模式）', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/project/src/file.ts',
        'r',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(true)
    })

    it('写模式下工作目录内的路径应放行', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/project/src/new-file.ts',
        'w',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(true)
    })
  })

  describe('写模式局限性', () => {
    it('写模式下非白名单/工作目录路径应被拦截', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/other/file.txt',
        'w',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('写权限')
    })

    it('读模式下非白名单/工作目录路径应放行', async () => {
      const result = await securityPort.isPathAllowed(
        '/home/user/other/file.txt',
        'r',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(true)
    })
  })

  describe('路径无法解析', () => {
    it('targetPath 无法解析时应拦截', async () => {
      mockTryCanonicalizePartial.mockResolvedValue(null)
      const result = await securityPort.isPathAllowed(
        '/invalid/path',
        'r',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('路径无法解析')
    })

    it('workspace 无法解析时写模式不应放行', async () => {
      // mock workspace 解析失败
      mockTryCanonicalize.mockImplementation(async (path: string) => {
        if (path === workspace) return null // workspace 解析失败
        return path
      })
      const result = await securityPort.isPathAllowed(
        '/home/user/project/src/file.ts',
        'w',
        workspace,
        blacklist,
        whitelist,
      )
      expect(result.allowed).toBe(false)
    })
  })

  describe('Windows 路径处理', () => {
    it('应处理 Windows 反斜杠路径', async () => {
      const winWorkspace = 'C:/Users/me/project'
      const result = await securityPort.isPathAllowed(
        'C:\\Users\\me\\project\\src\\file.ts',
        'r',
        winWorkspace,
        [],
        [],
      )
      expect(result.allowed).toBe(true)
    })

    it('应拦截 Windows 系统目录', async () => {
      const result = await securityPort.isPathAllowed(
        'C:/Windows/System32/config/SAM',
        'r',
        'C:/Users/me/project',
        ['C:/Windows'],
        [],
      )
      expect(result.allowed).toBe(false)
    })
  })

  describe('canonicalizeList', () => {
    it('应返回路径的规范化结果', async () => {
      const results = await securityPort.canonicalizeList([
        '/etc',
        '/home',
      ])
      expect(results).toHaveLength(2)
      expect(results[0].raw).toBe('/etc')
      expect(results[1].canonical).toBe('/home')
    })

    it('规范化失败的路径应被跳过', async () => {
      mockTryCanonicalize.mockImplementation(async (path: string) => {
        if (path === '/invalid') return null
        return path
      })
      const results = await securityPort.canonicalizeList([
        '/valid',
        '/invalid',
      ])
      expect(results).toHaveLength(1)
      expect(results[0].raw).toBe('/valid')
    })
  })
})

describe('SecurityPort — getDefaultBlacklist', () => {
  it('Windows 默认黑名单应包含系统目录', () => {
    const list = securityPort.getDefaultBlacklist('windows')
    expect(list).toContain('C:/Windows')
    expect(list).toContain('C:/Windows/System32')
    expect(list).toContain('C:/Program Files')
    expect(list).not.toContain('/etc/shadow') // Windows 没有 /etc
  })

  it('macOS 默认黑名单应包含系统目录', () => {
    const list = securityPort.getDefaultBlacklist('macos')
    expect(list).toContain('/etc')
    expect(list).toContain('/Applications')
    expect(list).toContain('/Library')
    expect(list).toContain('~/Library')
    expect(list).toContain('~/.ssh')
  })

  it('Linux 默认黑名单应包含系统目录', () => {
    const list = securityPort.getDefaultBlacklist('linux')
    expect(list).toContain('/etc')
    expect(list).toContain('/var')
    expect(list).toContain('/proc')
    expect(list).toContain('/sys')
    expect(list).toContain('/root')
    expect(list).toContain('~/.ssh')
  })

  it('各平台黑名单应包含通用敏感路径', () => {
    for (const platform of ['windows', 'macos', 'linux'] as const) {
      const list = securityPort.getDefaultBlacklist(platform)
      expect(list).toContain('~/.aws')
      expect(list).toContain('~/.kube')
      expect(list).toContain('~/.docker')
    }
  })
})

describe('SecurityPort — getDefaultWhitelist', () => {
  it('Windows 默认白名单应包含临时目录和文档目录', () => {
    const list = securityPort.getDefaultWhitelist('windows')
    expect(list).toContain('%USERPROFILE%/AppData/Local/Temp')
    expect(list).toContain('%USERPROFILE%/Documents')
  })

  it('macOS 默认白名单应包含临时目录', () => {
    const list = securityPort.getDefaultWhitelist('macos')
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((p) => p.includes('TMPDIR') || p.includes('tmp'))).toBe(true)
  })

  it('Linux 默认白名单应包含临时目录', () => {
    const list = securityPort.getDefaultWhitelist('linux')
    expect(list).toContain('/tmp')
  })
})
