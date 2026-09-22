/**
 * ReadSkillSourceMessage 测试 — read_skill_source 工具调用的展示组件
 *
 * 覆盖：
 * - parseSkillSourceContent 对「路径 / 目录结构 / SKILL.md」三段的切分（含 frontmatter 保留）
 * - 结构标记缺失时返回 null（调用方回退原文）
 * - 短文本：技能名 + 技能路径
 * - 展开视图：标题条 + 路径 + 目录树 + SKILL.md 分区渲染；异常回退 <pre> 原文
 * - 折叠时不挂载、展开时「打开即居中」一次（hook 只在组件顶层调用，不产生 React 内部报错）
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import ReadSkillSourceMessage, {
  parseSkillSourceContent,
} from '@/ui/pages/chat/components/tool-call/ReadSkillSourceMessage'

/**
 * MarkdownRenderer 会拉起 Monaco（jsdom 里无法渲染编辑器），
 * 这里换成最小替身：本用例只验证「SKILL.md 正文被交给 Markdown 渲染」。
 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: any) => <div className="md-stub">{content}</div>,
}))

const SKILL_PATH = 'C:/Users/x/AppData/Roaming/virlen/skills/code-reviewer'

/** SKILL.md 分段标记 */
const MD_MARK_FOR_TEST = '# 📄 SKILL.md'

/** 与 infrastructure/tools/skill/read-skill-source.ts 的拼装格式保持一致 */
const RESULT = [
  `**📁 技能路径**: \`${SKILL_PATH}\``,
  '',
  '---',
  '',
  '# 📂 目录结构',
  '📂 code-reviewer/',
  '  ├── SKILL.md',
  '  └── scripts/',
  '      └── run.js',
  '',
  '---',
  '',
  '# 📄 SKILL.md',
  '',
  '---',
  'name: code-reviewer',
  'description: 代码审查',
  '---',
  '',
  '# 代码审查',
  '',
  '按以下步骤检查代码。',
].join('\n')

const useContent: any = {
  id: '1',
  name: 'read_skill_source',
  input: { name: 'code-reviewer' },
}

function expandView(content: string, isError = false) {
  const cmp = new ReadSkillSourceMessage()
  return renderToStaticMarkup(
    <>
      {cmp.getExpandView({
        useContent,
        message: { id: 'r1', role: 'tool', content, timestamp: 0, isError } as any,
        expand: true,
      })}
    </>,
  )
}

function shortText(content: string) {
  const cmp = new ReadSkillSourceMessage()
  return renderToStaticMarkup(
    <>
      {cmp.getShortText({
        useContent,
        message: { id: 'r1', role: 'tool', content, timestamp: 0 } as any,
        expand: false,
      })}
    </>,
  )
}

describe('parseSkillSourceContent', () => {
  it('切分出技能路径 / 目录结构 / SKILL.md 三段', () => {
    const parts = parseSkillSourceContent(RESULT)!
    expect(parts.skillPath).toBe(SKILL_PATH)
    expect(parts.tree).toContain('📂 code-reviewer/')
    expect(parts.tree).toContain('├── SKILL.md')
    // 目录树段不残留分隔线，也不会吞掉 SKILL.md 段
    expect(parts.tree).not.toContain('---')
    expect(parts.tree).not.toContain(MD_MARK_FOR_TEST)
    expect(parts.skillMd).toContain('# 代码审查')
    expect(parts.skillMd).not.toContain(MD_MARK_FOR_TEST)
  })

  it('SKILL.md 的 YAML frontmatter 必须原样保留', () => {
    const parts = parseSkillSourceContent(RESULT)!
    // 目录树修剪只吃首尾的 ---，不能把 frontmatter 的 --- 也一并吃掉
    expect(parts.skillMd.startsWith('---\nname: code-reviewer')).toBe(true)
    expect(parts.skillMd).toContain('description: 代码审查')
  })

  it('结构标记缺失时返回 null（调用方回退原文）', () => {
    expect(parseSkillSourceContent('')).toBeNull()
    expect(parseSkillSourceContent('随便一段普通文本')).toBeNull()
  })

  it('只有 SKILL.md 段时仍可解析（部分降级）', () => {
    const parts = parseSkillSourceContent(
      `${MD_MARK_FOR_TEST}\n\n# 标题\n正文`,
    )!
    expect(parts.tree).toBe('')
    expect(parts.skillMd).toContain('# 标题')
  })
})

describe('ReadSkillSourceMessage', () => {
  it('工具名与标签', () => {
    const cmp = new ReadSkillSourceMessage()
    expect(cmp.getToolName()).toBe('read_skill_source')
    expect(cmp.getToolLabel('read_skill_source')).toBe('查看技能源代码')
    // 自绘卡片：不使用 .tool-call-expand-view 包裹
    expect(cmp.diyWrapper()).toBe(true)
  })

  it('短文本展示技能名与技能路径', () => {
    const html = shortText(RESULT)
    expect(html).toContain('code-reviewer')
    expect(html).toContain('skill-source-short-path')
    expect(html).toContain(SKILL_PATH)
  })

  it('展开视图：标题条 + 路径 + 目录树 + SKILL.md 分区', () => {
    const html = expandView(RESULT)
    expect(html).toContain('skill-source-view')
    // 标题条：技能名 + 「打开技能目录」图标按钮
    expect(html).toContain('skill-source-name')
    expect(html).toContain('skill-source-icon-btn')
    // 元信息行：路径
    expect(html).toContain('skill-source-meta-path')
    expect(html).toContain(SKILL_PATH)
    // 分区：目录树（保留树形字符）+ SKILL.md（交给 MarkdownRenderer 替身）
    expect(html).toContain('skill-source-tree')
    expect(html).toContain('├── SKILL.md')
    expect(html).toContain('md-stub')
    expect(html).toContain('# 代码审查')
    // 渲染后的正文不应再带分段标记
    expect(html).not.toContain(MD_MARK_FOR_TEST)
  })

  it('内容无法解析时回退整段原文', () => {
    const html = expandView('没有分段标记的内容')
    expect(html).toContain('skill-source-raw')
    expect(html).toContain('没有分段标记的内容')
  })

  it('错误结果走 error 分支', () => {
    const html = expandView('错误：技能未注册', true)
    expect(html).toContain('class="error"')
    expect(html).toContain('技能未注册')
  })

  it('结果尚未返回时不崩溃', () => {
    const cmp = new ReadSkillSourceMessage()
    expect(
      cmp.getExpandView({
        useContent,
        message: undefined as any,
        expand: true,
      }),
    ).toBeNull()
  })

  it('入参没有技能名时短文本退回结果开头', () => {
    const cmp = new ReadSkillSourceMessage()
    const html = renderToStaticMarkup(
      <>
        {cmp.getShortText({
          useContent: {
            id: '1',
            name: 'read_skill_source',
            input: {},
          } as any,
          message: {
            id: 'r1',
            role: 'tool',
            content: '错误：请提供技能名称（name 参数）。',
            timestamp: 0,
          } as any,
          expand: false,
        })}
      </>,
    )
    expect(html).toContain('错误：请提供技能名称')
  })
})

/**
 * 「打开即居中」回归。
 *
 * 与 tool-call-autocenter.test.tsx 同一套思路：useAutoCenter 只能在**组件顶层**无条件调用。
 * 这里同时断言：① 折叠时不挂载；② 每次展开只居中一次；③ 不出现 React 内部报错（hook 未条件调用）。
 */
describe('read_skill_source 展开视图：打开即居中', () => {
  const inst = new ReadSkillSourceMessage()
  const message: any = { id: 'r1', role: 'tool', content: RESULT, timestamp: 0 }

  /** 与 tool-call/index.tsx 的 ToolCallExpandView 同构：在组件渲染里调 getExpandView */
  function Harness({ expand }: { expand: boolean }) {
    return (
      <div className="host">
        {inst.getExpandView({ useContent, message, expand }) as any}
      </div>
    )
  }

  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let errors: string[]
  let origConsoleError: typeof console.error
  const scrollCalls: unknown[] = []
  const origScrollTo = (Element.prototype as any).scrollTo

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    scrollCalls.length = 0
    // jsdom 未实现 scrollTo：替身用于计数
    ;(Element.prototype as any).scrollTo = (...args: unknown[]) =>
      scrollCalls.push(args)
    errors = []
    origConsoleError = console.error
    console.error = (...args: any[]) => {
      errors.push(args.map((a) => (a && a.message) || String(a)).join(' '))
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    console.error = origConsoleError
    act(() => root.unmount())
    container.remove()
    ;(Element.prototype as any).scrollTo = origScrollTo
  })

  it('折叠不挂载，每次展开居中一次，且无 React 内部报错', () => {
    act(() => root.render(<Harness expand={false} />))
    expect(container.querySelector('.skill-source-view')).toBeNull()
    expect(scrollCalls.length).toBe(0)

    act(() => root.render(<Harness expand={true} />))
    expect(container.querySelector('.skill-source-view')).toBeTruthy()
    expect(scrollCalls.length).toBe(1)

    act(() => root.render(<Harness expand={false} />))
    expect(container.querySelector('.skill-source-view')).toBeNull()
    expect(scrollCalls.length).toBe(1) // 收起不居中

    act(() => root.render(<Harness expand={true} />))
    expect(scrollCalls.length).toBe(2) // 再次展开 → 再居中一次

    expect(errors).toEqual([])
  })
})
