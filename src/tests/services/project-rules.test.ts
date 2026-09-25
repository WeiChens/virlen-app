/**
 * 「项目规则 / 记忆文件」（AGENTS.md 等）—— 会话创建时注入系统提示词的契约
 *
 * 钉住四件容易被改坏的事：
 *  1. **默认值**：老 Agent 数据没有该字段 → 按 AGENTS.md 处理；显式空串 → 不注入；
 *  2. **路径安全**：绝对路径 / `~` / 盘符 / `..` 一律拒绝（否则 Agent 配置能把
 *     `~/.ssh/id_rsa` 读进提示词发给模型服务商）；
 *  3. **超限行为**：> 64 KB **不注入**（不做截断 —— 半截规则比没有更危险）；
 *  4. **静默降级**：不存在 / 二进制 / 编码不可识别 / 非 Tauri 环境一律返回空串，绝不抛错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  buildProjectRulesPrompt,
  DEFAULT_PROJECT_RULES_FILE,
  isSafeProjectRulesPath,
  MAX_PROJECT_RULES_BYTES,
  normalizeProjectRulesPath,
  resolveProjectRulesFile,
} from '@/domain/agent/project-rules'
import { loadProjectRulesPrompt } from '@/services/project-rules-service'

const invokeMock = vi.mocked(invoke)

beforeEach(() => {
  invokeMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('resolveProjectRulesFile', () => {
  it('未配置（老数据）→ 默认 AGENTS.md', () => {
    expect(resolveProjectRulesFile({})).toBe(DEFAULT_PROJECT_RULES_FILE)
    expect(resolveProjectRulesFile(undefined)).toBe(DEFAULT_PROJECT_RULES_FILE)
    expect(resolveProjectRulesFile(null)).toBe(DEFAULT_PROJECT_RULES_FILE)
  })

  it('显式空串 / 纯空白 → 不注入（返回空串）', () => {
    expect(resolveProjectRulesFile({ projectRulesFile: '' })).toBe('')
    expect(resolveProjectRulesFile({ projectRulesFile: '   ' })).toBe('')
  })

  it('自定义值会被 trim', () => {
    expect(resolveProjectRulesFile({ projectRulesFile: ' .cursor/rules.md ' })).toBe(
      '.cursor/rules.md',
    )
  })
})

describe('isSafeProjectRulesPath / normalizeProjectRulesPath', () => {
  it('允许工作目录内的相对路径', () => {
    expect(isSafeProjectRulesPath('AGENTS.md')).toBe(true)
    expect(isSafeProjectRulesPath('.cursor/rules.md')).toBe(true)
    expect(isSafeProjectRulesPath('docs\\MEMORY.md')).toBe(true)
  })

  it('归一化：反斜杠 → /，丢弃 `.` 段与重复斜杠', () => {
    expect(normalizeProjectRulesPath('docs\\MEMORY.md')).toBe('docs/MEMORY.md')
    expect(normalizeProjectRulesPath('./AGENTS.md')).toBe('AGENTS.md')
    expect(normalizeProjectRulesPath('a/./b.md')).toBe('a/b.md')
    expect(normalizeProjectRulesPath('a//b.md')).toBe('a/b.md')
    expect(normalizeProjectRulesPath('  AGENTS.md  ')).toBe('AGENTS.md')
  })

  it('拒绝绝对路径 / 家目录 / 盘符 / 上跳', () => {
    expect(isSafeProjectRulesPath('/etc/passwd')).toBe(false)
    expect(isSafeProjectRulesPath('C:/Users/x/.ssh/id_rsa')).toBe(false)
    expect(isSafeProjectRulesPath('~/.ssh/id_rsa')).toBe(false)
    expect(isSafeProjectRulesPath('../../secrets.env')).toBe(false)
    expect(isSafeProjectRulesPath('a/../b.md')).toBe(false)
    // 归一化后也不能上跳（先拆段再判，不会被 ./a/../b 绕开）
    expect(normalizeProjectRulesPath('.//a/../b.md')).toBeNull()
  })

  it('拒绝空值与超长路径', () => {
    expect(normalizeProjectRulesPath('')).toBeNull()
    expect(normalizeProjectRulesPath('   ')).toBeNull()
    expect(normalizeProjectRulesPath('./')).toBeNull()
    expect(isSafeProjectRulesPath('')).toBe(false)
    expect(isSafeProjectRulesPath('a'.repeat(201))).toBe(false)
  })
})

describe('buildProjectRulesPrompt', () => {
  it('带标题、来源说明与正文', () => {
    const prompt = buildProjectRulesPrompt('AGENTS.md', '# 项目约定\n用 pnpm')
    expect(prompt).toContain('# Project Rules (AGENTS.md)')
    expect(prompt).toContain('The content below comes from `AGENTS.md`')
    expect(prompt).toContain('# 项目约定')
    expect(prompt.endsWith('用 pnpm')).toBe(true)
  })
})

describe('loadProjectRulesPrompt', () => {
  const ws = 'E:/proj'

  it('路径不安全 → 不发起任何调用（兜底存量脏配置）', async () => {
    expect(await loadProjectRulesPrompt(ws, '../secrets.env')).toBe('')
    expect(await loadProjectRulesPrompt(ws, 'C:/Users/x/.ssh/id_rsa')).toBe('')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('未配置文件名 / 无工作目录 → 空串', async () => {
    expect(await loadProjectRulesPrompt(ws, '')).toBe('')
    expect(await loadProjectRulesPrompt(ws, '   ')).toBe('')
    expect(await loadProjectRulesPrompt(undefined, 'AGENTS.md')).toBe('')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('文件不存在 → 空串（不报错）', async () => {
    invokeMock.mockResolvedValueOnce(null)
    expect(await loadProjectRulesPrompt(ws, 'AGENTS.md')).toBe('')
  })

  it('同名目录 → 空串', async () => {
    invokeMock.mockResolvedValueOnce({ exists: true, is_file: false, size: 0 })
    expect(await loadProjectRulesPrompt(ws, 'AGENTS.md')).toBe('')
  })

  it(`超过 ${MAX_PROJECT_RULES_BYTES} 字节 → 不注入（不截断）`, async () => {
    invokeMock.mockResolvedValueOnce({
      exists: true,
      is_file: true,
      size: MAX_PROJECT_RULES_BYTES + 1,
    })
    expect(await loadProjectRulesPrompt(ws, 'AGENTS.md')).toBe('')
    // 只探测了大小，没有把文件读进内存
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('stat_path', {
      path: 'E:/proj/AGENTS.md',
    })
  })

  it('读取失败（二进制 / 编码不可识别 / 非 Tauri）→ 空串', async () => {
    invokeMock
      .mockResolvedValueOnce({ exists: true, is_file: true, size: 100 })
      .mockRejectedValueOnce(new Error('Binary file is not supported'))
    expect(await loadProjectRulesPrompt(ws, 'AGENTS.md')).toBe('')
  })

  it('内容为纯空白 → 空串', async () => {
    invokeMock
      .mockResolvedValueOnce({ exists: true, is_file: true, size: 4 })
      .mockResolvedValueOnce({ content: '\n\n  \n', byte_size: 4, line_count: 3 })
    expect(await loadProjectRulesPrompt(ws, 'AGENTS.md')).toBe('')
  })

  it('正常读取 → 注入提示词片段，路径统一为 /', async () => {
    invokeMock
      .mockResolvedValueOnce({ exists: true, is_file: true, size: 12 })
      .mockResolvedValueOnce({
        content: '  用 pnpm  ',
        byte_size: 12,
        line_count: 1,
      })
    const prompt = await loadProjectRulesPrompt('E:\\proj\\', 'AGENTS.md')
    expect(prompt).toContain('# Project Rules (AGENTS.md)')
    expect(prompt).toContain('用 pnpm')
    expect(invokeMock).toHaveBeenLastCalledWith('read_file_with_hash', {
      path: 'E:/proj/AGENTS.md',
    })
  })

  it('读取时用归一化后的路径（`./AGENTS.md` 与 `docs\\M.md` 不再拒绝）', async () => {
    invokeMock
      .mockResolvedValueOnce({ exists: true, is_file: true, size: 3 })
      .mockResolvedValueOnce({ content: 'abc', byte_size: 3, line_count: 1 })
    const prompt = await loadProjectRulesPrompt(ws, './AGENTS.md')
    expect(invokeMock).toHaveBeenCalledWith('stat_path', {
      path: 'E:/proj/AGENTS.md',
    })
    expect(prompt).toContain('# Project Rules (AGENTS.md)')

    invokeMock.mockReset()
    invokeMock
      .mockResolvedValueOnce({ exists: true, is_file: true, size: 3 })
      .mockResolvedValueOnce({ content: 'abc', byte_size: 3, line_count: 1 })
    await loadProjectRulesPrompt(ws, 'docs\\M.md')
    expect(invokeMock).toHaveBeenCalledWith('stat_path', {
      path: 'E:/proj/docs/M.md',
    })
  })
})
