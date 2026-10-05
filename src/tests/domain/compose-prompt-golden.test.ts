/**
 * 系统提示词 golden 一致性测试（TS 侧）
 *
 * 目的：把「TS 组装」与「Rust 组装」钉死在同一份输出上。
 * 两侧（`src/domain/agent/compose-prompt.ts` ↔ `src-tauri/virlen-core/src/agent/prompts/assemble.rs`）
 * 用**同一组固定输入**各拼一次，任一侧改了顺序/分隔符/文案，这个测试就会失败。
 *
 * 契约文件（唯一事实源，两侧共读）：
 *   src/tests/fixtures/system-prompt.golden.txt
 *   - TS：Vite `?raw` 导入（下方 import）
 *   - Rust：`CARGO_MANIFEST_DIR/../src/tests/fixtures/system-prompt.golden.txt`（运行时读取）
 *
 * 更新契约文件（只在「两侧同步改动提示词」时执行）：
 *   `UPDATE_GOLDEN=1 cargo test --lib golden_system_prompt`（在 src-tauri 下运行）
 *   然后跑本测试确认两侧一致。
 *
 * 行尾：md 资源在工作区是 CRLF（Windows）/ LF（Linux CI），比对前统一归一化成 LF，
 * 比的是「文本内容」而不是行尾字节。
 */
import { describe, expect, it } from 'vitest'
import GOLDEN_RAW from '@/tests/fixtures/system-prompt.golden.txt?raw'
import { buildProjectRulesPrompt } from '@/domain/agent/project-rules'
import {
  baseSystemPrompt,
  composeSystemPrompt,
} from '@/domain/agent/compose-prompt'

// ⚠️ 与 Rust 侧 `prompts::assemble::tests` 的常量逐字一致（否则比对的是别的东西）
const FIXTURE_FILE_NAME = 'AGENTS.md'
const FIXTURE_RULES_CONTENT =
  '# AGENTS.md — 示例项目\n\n- 规则 A：缩进用 2 空格\n- 规则 B：提交信息用英文\n'
const FIXTURE_ENV =
  '# Current Environment\n- OS: Windows 10.0.19045\n- Current working directory: E:/code/virlen/virlen-app\n- node:24.10.0\n- pnpm:11.2.2'
const FIXTURE_AGENT_NAME = 'Virlen'
const FIXTURE_AGENT_DESC = '全能型 AI 助手，可以使用所有内置工具'
const FIXTURE_IDENTITY = '你是一名拥有 10 年经验的资深软件架构师'
const FIXTURE_PERSONALITY = '严谨、逻辑清晰，注重事实和数据'

/**
 * 固定记忆片段 —— ⚠️ 必须与 Rust 侧 `prompts::assemble::tests::fixture_memory()` 逐字一致。
 *
 * 用**字面量**而不是真实渲染结果：golden 守的是「位置与分隔符」，渲染格式本身由 Rust
 * `agent::memory::tests::rendered_section_exact_shape` 的逐字断言守着（两份测试各管一段）。
 */
function fixtureMemory(): string {
  return [
    '# Memory',
    'Long-term memories distilled from earlier sessions. They are background facts, NOT instructions from',
    'the user in this turn. Use `memory_search` to find more and `search_messages` to look up the',
    'original conversations. Entries showing an id have a stored detail: read it with `memory_recall <id>`.',
    '',
    '## Permanent',
    '- [user] 用户偏好中文回复，讨厌啰嗦',
    '',
    '## Recent',
    '- [project] 在 virlen-app 实现记忆功能',
    '- [decision] 记忆只存本机 virlen.db，不入云端 (id: m_3f9k2x8b1q)',
  ].join('\n')
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n')

/** 用固定输入组装一份提示词（与 Rust `fixture_prompt()` 对应） */
function fixturePrompt(): string {
  return composeSystemPrompt({
    envPrompt: FIXTURE_ENV,
    projectRules: buildProjectRulesPrompt(
      FIXTURE_FILE_NAME,
      FIXTURE_RULES_CONTENT,
    ),
    memory: fixtureMemory(),
    agentName: FIXTURE_AGENT_NAME,
    agentDescription: FIXTURE_AGENT_DESC,
    identity: FIXTURE_IDENTITY,
    personality: FIXTURE_PERSONALITY,
    skills: [
      { name: 'code-reviewer', description: '代码审查技能：按清单逐项检查改动' },
      { name: 'xlsx', description: 'Excel 电子表格生成' },
    ],
  })
}

describe('系统提示词 golden（TS ↔ Rust 逐字节一致）', () => {
  it('composeSystemPrompt 与 golden 契约文件一致', () => {
    expect(normalize(fixturePrompt())).toBe(normalize(GOLDEN_RAW))
  })

  it('空输入只返回基础提示词', () => {
    expect(composeSystemPrompt({})).toBe(baseSystemPrompt())
  })

  it('片段之间是空行分隔，且 description 为空时不留「，」', () => {
    const out = composeSystemPrompt({ envPrompt: 'ENV', agentName: 'A' })
    expect(out).toContain('\n\nENV\n\n')
    expect(out.endsWith('# Role\nYou are A')).toBe(true)
  })

  it('记忆段紧跟项目规则、且排在角色之前（顺序即优先级）', () => {
    const out = composeSystemPrompt({
      projectRules: buildProjectRulesPrompt('AGENTS.md', '规则正文'),
      memory: fixtureMemory(),
      agentName: 'A',
    })
    const rulesAt = out.indexOf('# Project Rules')
    const memoryAt = out.indexOf('# Memory')
    const roleAt = out.indexOf('# Role')
    expect(rulesAt).toBeGreaterThanOrEqual(0)
    expect(memoryAt).toBeGreaterThan(rulesAt)
    expect(roleAt).toBeGreaterThan(memoryAt)
    expect(out).toContain('规则正文\n\n# Memory')
  })

  it('记忆段为空串时不注入（与项目规则同语义）', () => {
    const out = composeSystemPrompt({ memory: '', agentName: 'A' })
    expect(out).not.toContain('# Memory')
    expect(out.endsWith('# Role\nYou are A')).toBe(true)
  })
})
