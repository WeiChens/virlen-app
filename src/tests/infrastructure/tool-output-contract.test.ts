/**
 * Group A 工具「模型侧固定英文 + UI 侧结构化 uiData」契约测试（P4b）
 *
 * 背景：工具结果 `content` 是「模型 + UI」双用途字段。为消除
 * 「Rust 引擎给英文 / TS 引擎随 UI 语言给中文」的分叉，模型侧一律**固定英文**，
 * UI 侧改走**语言无关的结构化 `uiData`**，由组件按 UI 语言渲染。
 *
 * 这里钉住两条：
 *   1. 执行器产出与 UI 语言无关（当前 UI 语言为中文时仍是英文）；
 *   2. `uiData` 形状（供组件与未来的 Rust 原生实现共同遵守）。
 */
import { describe, it, expect, vi } from 'vitest'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext } from '@/domain/tools/types'

// 引入分类（触发 toolRegistry.register 副作用）
import '@/infrastructure/tools/system'
import '@/infrastructure/tools/skill'

vi.mock('@/skill', () => ({
  listRegisteredSkills: () => [
    {
      meta: {
        name: 'code-reviewer',
        description: 'Code review helper',
        version: '1.0.0',
        tags: ['dev'],
      },
    },
    { meta: { name: 'other', description: 'Unused skill' } },
  ],
  getRegisteredSkill: (name: string) =>
    name === 'code-reviewer'
      ? { meta: { name: 'code-reviewer' }, path: 'C:/skills/code-reviewer' }
      : undefined,
  getSkillFileTree: async () => [
    { name: 'SKILL.md' },
    { name: 'scripts', children: [{ name: 'run.js' }] },
  ],
  readSkillMd: async () => '# Code Review\n',
}))

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
    ...over,
  }
}

async function run(name: string, args: any, ctx = makeCtx()): Promise<any> {
  const tool = await toolRegistry.get(name)
  expect(tool, `${name} 应已注册`).toBeDefined()
  return tool!.executor(args, ctx)
}

const CJK = /[\u4e00-\u9fff]/

describe('get_current_time：模型侧英文 + 语言无关 uiData', () => {
  it('content 为英文时间格式（不含中文）', async () => {
    const r = await run('get_current_time', { timezone: 'Asia/Shanghai' })
    expect(typeof r.content).toBe('string')
    expect(r.content).not.toMatch(CJK)
    // 英文 locale 会带英文的星期名 / 月名
    expect(r.content).toMatch(/[A-Za-z]{3,}/)
  })

  it('uiData 给出时间戳 + 时区（供组件按 UI 语言本地化）', async () => {
    const r = await run('get_current_time', { timezone: 'UTC' })
    expect(typeof r.uiData.timestamp).toBe('number')
    expect(r.uiData.timestamp).toBeGreaterThan(0)
    expect(r.uiData.timezone).toBe('UTC')
  })

  it('未传时区时回落 Asia/Shanghai', async () => {
    const r = await run('get_current_time', {})
    expect(r.uiData.timezone).toBe('Asia/Shanghai')
  })

  // Rust 原生实现（`native_tools/system/get_current_time.rs`，chrono-tz）必须与下面两条逐字对齐
  it('content 形状与 Intl en-US 一致（星期长名 + MM/DD/YYYY + 12 小时制补零 + AM/PM）', async () => {
    const r = await run('get_current_time', { timezone: 'Asia/Shanghai' })
    expect(r.content).toMatch(
      /^[A-Z][a-z]+day, \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} (AM|PM)$/,
    )
  })

  it('非法时区 → ToolError（与 Rust 同文案）+ 结构化 uiData 供界面本地化', async () => {
    await expect(
      run('get_current_time', { timezone: 'Not/AZone' }),
    ).rejects.toMatchObject({
      name: 'ToolError',
      message: 'Invalid time zone: "Not/AZone"',
      uiData: { timezone: 'Not/AZone', errorKind: 'invalid_timezone' },
    })
  })
})

describe('list_skills：模型侧英文 + uiData.skills', () => {
  it('只返回该 agent 拥有的技能，且 content 英文', async () => {
    const r = await run('list_skills', {}, makeCtx({ skills: ['code-reviewer'] }))
    expect(r.content).toContain('Enabled skills (1)')
    expect(r.content).not.toMatch(CJK)
    expect(r.uiData.skills).toHaveLength(1)
    expect(r.uiData.skills[0]).toMatchObject({
      name: 'code-reviewer',
      description: 'Code review helper',
      version: '1.0.0',
      tags: ['dev'],
    })
  })

  it('没有启用技能 → 空清单 + 英文提示', async () => {
    const r = await run('list_skills', {}, makeCtx({ skills: [] }))
    expect(r.content).toMatch(/No skills/)
    expect(r.uiData.skills).toEqual([])
  })
})

describe('read_skill_source：模型侧英文 + 三段结构化', () => {
  it('content 用英文分段标记，uiData 给出 skillPath/tree/md', async () => {
    const r = await run(
      'read_skill_source',
      { name: 'code-reviewer' },
      makeCtx({ skills: ['code-reviewer'] }),
    )
    expect(r.content).toContain('**📁 Skill path**')
    expect(r.content).toContain('# 📂 Directory structure')
    expect(r.content).not.toMatch(CJK)
    expect(r.uiData.skillPath).toBe('C:/skills/code-reviewer')
    expect(r.uiData.tree).toContain('SKILL.md')
    expect(r.uiData.md).toContain('# Code Review')
  })

  it('未启用该技能 → 英文错误（且不返回 uiData）', async () => {
    const r = await run(
      'read_skill_source',
      { name: 'nope' },
      makeCtx({ skills: ['code-reviewer'] }),
    )
    expect(r.content).toMatch(/does not have the "nope" skill enabled/)
  })
})
