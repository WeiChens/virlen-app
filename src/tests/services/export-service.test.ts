/**
 * export-service 测试 — 会话导出为 HTML（气泡 UI，与聊天区 message-list 同款）
 *
 * 覆盖场景：
 * - 文档骨架（doctype / head / 内嵌样式 / 会话元信息）
 * - 布局：文档头固定不滚动、消息区是唯一滚动容器，滚动条样式（含 Chromium/Firefox 分开）
 * - 气泡：用户右对齐纯文本气泡、助手左对齐 Markdown 气泡、时间行
 * - 思考折叠块（默认收起、带耗时）
 * - 引用 chip / 技能卡片 / 文件 chip（**图片不导出**）
 * - 行模型（与聊天区同源）：`tool` 消息不占行、连续工具调用合成一组、尾部段默认展开、单次调用保持单卡
 * - 工具卡片：状态点 / 工具名 / 摘要 / 耗时 + 展开视图（参数 + 返回，超过 50vh 内部滚动）
 * - 孤儿工具结果单独成卡（内容不丢）
 * - 摘要卡 / 反馈卡
 * - omitToolCalls / omitThinking 选项
 * - 插值转义（标题 / 工具参数 / 工具输出 / 文件路径 / 引用正文）
 * - 真实 Markdown 渲染链（react-markdown）产出的 HTML
 */
import { describe, it, expect } from 'vitest'
import {
  sessionToHtml,
  createMarkdownHtmlRenderer,
  type ExportOptions,
  type MarkdownToHtml,
} from '@/services/export-service'
import type { Session, Message } from '@/types'

// Mock i18n
vi.mock('@/ui/i18n', () => ({
  t: (key: string) => key,
  tpl: (template: string, data: Record<string, any>) => {
    let result = template
    for (const [key, value] of Object.entries(data)) {
      result = result.replace(`$__${key}__`, String(value))
    }
    return result
  },
  getCurrentLanguage: () => 'zh-CN',
}))

// Mock agentRepo
vi.mock('@/infrastructure/agentRepo', () => ({
  agentRepo: {
    load: () => ({
      agents: [{ id: 'agent-1', name: '小助手' }],
    }) as any,
  },
}))

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: '测试会话',
    messages: [],
    providerConfigId: 'provider-1',
    modelId: 'gpt-4',
    systemPrompt: '你是一个助手',
    params: { temperature: 0.7, topP: 1, maxTokens: 2048, stream: true },
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    tags: [],
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    role: 'user',
    content: '',
    timestamp: 1766000000000,
    ...overrides,
  }
}

/** 测试用桩：Markdown 只做最小转义后包一层 <p>，便于断言结构（真实渲染链另有专门用例） */
const stubRender: MarkdownToHtml = (md) =>
  `<p>${md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</p>`

function toHtml(session: Session, options: Partial<ExportOptions> = {}): string {
  return sessionToHtml(session, stubRender, {
    omitToolCalls: false,
    omitThinking: false,
    ...options,
  })
}

/** 统计某个片段出现次数 */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** 一次工具调用（assistant 消息上的 toolCalls） */
function toolCallMessage(
  id: string,
  name: string,
  input: Record<string, any> = {},
  content = '',
): Message {
  return makeMessage({
    role: 'assistant',
    content,
    toolCalls: [{ type: 'tool_use', id, name, input }],
  })
}

describe('sessionToHtml — 文档骨架', () => {
  it('空会话也生成完整的 HTML 文档（含内嵌样式与元信息）', () => {
    const html = toHtml(makeSession({ messages: [] }))

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<meta charset="utf-8" />')
    expect(html).toContain('<title>测试会话</title>')
    expect(html).toContain('<h1 class="export-title">测试会话</h1>')
    expect(html).toContain('<style>')
    expect(html).toContain('.message-bubble')
    expect(html).toContain('<div class="chat-messages">')
    expect(html).toContain('gpt-4')
    expect(html).toContain('消息数')
    expect(html).toContain('</html>')
    // 没有消息就没有气泡
    expect(html).not.toContain('class="message-bubble')
  })

  it('会话绑定了 Agent 时元信息里显示 Agent 名', () => {
    const html = toHtml(makeSession({ agentId: 'agent-1' }))
    expect(html).toContain('Agent')
    expect(html).toContain('小助手')
  })

  it('角色名不是标题（不挤进文档大纲）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'user', content: '你好' }),
          makeMessage({ role: 'assistant', content: '你好！' }),
        ],
      }),
    )

    // 全文只有会话标题一个标题标签；角色靠气泡左右 / 配色区分
    expect(html.match(/<h[1-6][\s>]/g)?.length).toBe(1)
    expect(html).not.toContain('Assistant')
    expect(html).not.toContain('>User<')
  })
})

describe('sessionToHtml — 气泡', () => {
  it('用户消息是右对齐气泡，正文按纯文本输出（不渲染 Markdown，与聊天区一致）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'user', content: '第一行\n**粗体**' }),
        ],
      }),
    )

    expect(html).toContain('<div class="message-bubble user">')
    // 换行原样保留（CSS 用 white-space: pre-wrap 呈现）
    expect(html).toContain('<div class="message-content">第一行\n**粗体**</div>')
    expect(html).not.toContain('<strong>')
    expect(html).toContain('class="message-time"')
    // 绝对时间（导出文档离开应用后相对时间没有意义）
    expect(html).toMatch(/class="message-time">\d{4}\/\d{1,2}\/\d{1,2}/)
  })

  it('助手消息是左对齐气泡，正文走 Markdown 渲染', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'assistant', content: '你好！有什么可以帮你的？' }),
        ],
      }),
    )

    expect(html).toContain('<div class="message-bubble assistant">')
    expect(html).toContain(
      '<div class="message-content"><div class="markdown-renderer"><p>你好！有什么可以帮你的？</p></div></div>',
    )
  })

  it('没有可见内容的消息不产生空气泡', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'user', content: '' }),
          makeMessage({ role: 'assistant', content: '   ' }),
        ],
      }),
    )

    expect(html).not.toContain('class="message-bubble')
  })
})

describe('sessionToHtml — 思考过程', () => {
  it('思考内容是折叠块（默认收起）并带耗时', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'assistant',
            content: '答案是 42',
            reasoningContent: '让我想想…首先需要计算…',
            reasoningElapsedMs: 1876,
          }),
        ],
      }),
    )

    expect(html).toContain('<details class="reasoning-block">')
    expect(html).not.toContain('<details class="reasoning-block" open>')
    expect(html).toContain('<summary class="reasoning-header">')
    expect(html).toContain('思考过程')
    expect(html).toContain('<span class="reasoning-elapsed">1.9s</span>')
    // 思考文本在自己的容器里（左侧竖线 + 弱化的 Markdown）
    expect(html).toContain('<div class="reasoning-text">')
    expect(html).toContain('让我想想')
    // 折叠块在气泡里、正文之前
    expect(html.indexOf('reasoning-block')).toBeLessThan(html.indexOf('答案是 42'))
  })

  it('omitThinking=true 时思考块整个不输出；不勾选则保留', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'assistant',
          content: '答案是 42',
          reasoningContent: '让我想想…',
        }),
      ],
    })

    expect(toHtml(session)).toContain('<details class="reasoning-block">')
    expect(toHtml(session)).toContain('让我想想')

    const omitted = toHtml(session, { omitThinking: true })
    expect(omitted).not.toContain('<details class="reasoning-block">')
    expect(omitted).not.toContain('让我想想')
    expect(omitted).toContain('答案是 42')
  })
})

describe('sessionToHtml — 布局（文档头固定 + 消息区滚动）', () => {
  it('文档头不参与滚动：整页是 100vh 列布局，只让消息区滚', () => {
    const html = toHtml(makeSession({ messages: [] }))

    const shell = html.slice(
      html.indexOf('.chat-export {'),
      html.indexOf('.export-title {'),
    )
    // 整页：纵向 flex + 视口高（消息区吃剩余高度）
    expect(shell).toContain('display: flex')
    expect(shell).toContain('flex-direction: column')
    expect(shell).toContain('height: 100vh')
    // 文档头：flex: none（不伸缩、不随消息滚走）+ 底部分隔线
    const header = shell.slice(
      shell.indexOf('.export-header {'),
      shell.indexOf('.export-title {'),
    )
    expect(header).toContain('flex: none')
    expect(header).toContain('border-bottom')
    // 消息区：唯一滚动容器
    const messages = html.slice(
      html.indexOf('.chat-messages {'),
      html.indexOf('.message-bubble {'),
    )
    expect(messages).toContain('flex: 1')
    expect(messages).toContain('min-height: 0')
    expect(messages).toContain('overflow-y: auto')
    // 页面本身不滚（否则文档头也会被卷走）
    expect(html).toContain('overflow: hidden')
  })

  it('滚动条样式：细 / 圆角 / 半透明 + hover 加深；Firefox 走标准属性且与 webkit 隔开', () => {
    const html = toHtml(makeSession())

    expect(html).toContain('*::-webkit-scrollbar {')
    expect(html).toContain('*::-webkit-scrollbar-thumb {')
    expect(html).toContain('*::-webkit-scrollbar-thumb:hover {')
    expect(html).toContain('border-radius: 999px')
    expect(html).toContain('background-clip: padding-box')
    expect(html).toContain('--scrollbar-thumb-hover')
    // ⚠️ scrollbar-width 会让 Chromium 丢掉 ::-webkit-scrollbar，必须关在 @supports 里
    expect(html).toContain('@supports not selector(::-webkit-scrollbar)')
    expect(html).toContain('scrollbar-width: thin')
  })

  it('打印时回到普通文档流（固定头 / 内部滚动都放开，否则只能印出第一屏）', () => {
    const html = toHtml(makeSession())
    const print = html.slice(html.indexOf('@media print {'))

    expect(print).toContain('.chat-export { display: block; height: auto; }')
    expect(print).toContain('.chat-messages { display: block; overflow: visible; padding: 0; }')
  })
})

describe('sessionToHtml — 附件（引用 / 技能 / 文件）', () => {
  it('引用、技能、文件各自成块渲染', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'user',
            content: [
              { type: 'text', text: '接着说' },
              { type: 'quote', role: 'assistant', text: '上一轮的回答' },
              {
                type: 'skill',
                name: 'code-reviewer',
                path: 'C:/skills/cr',
                description: '代码审查',
                content: 'x'.repeat(20),
              },
            ] as any,
          }),
          makeMessage({
            role: 'user',
            content: [
              { type: 'file', path: 'C:/a/b.ts', isDir: false, size: 2048 },
              { type: 'file', path: 'C:/a/dir', isDir: true },
            ] as any,
          }),
        ],
      }),
    )

    // 引用 chip：色条 + 发送方 + 正文摘要
    expect(html).toContain('<div class="message-quotes">')
    expect(html).toContain('<span class="quote-chip-bar"></span>')
    expect(html).toContain('<span class="quote-chip-sender">AI</span>')
    expect(html).toContain('上一轮的回答')
    // 技能卡片：名称 + 字符数 + 描述
    expect(html).toContain('<div class="message-skills">')
    expect(html).toContain('<span class="skill-chip-name">code-reviewer</span>')
    expect(html).toContain('<span class="skill-chip-meta">20 字符</span>')
    expect(html).toContain('<span class="skill-chip-desc">代码审查</span>')
    // 文件 chip
    expect(html).toContain('<div class="message-files">')
    expect(html).toContain('<span class="file-chip-name">b.ts</span>')
    expect(html).toContain('<span class="file-chip-meta">2.0 KB</span>')
    expect(html).toContain('<span class="file-chip is-dir" title="C:/a/dir">')
    expect(html).toContain('接着说')
  })

  it('图片不导出：message-images 整块不输出、没有 <img>（base64 内嵌会把文档撑大好几 MB）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'user',
            content: [
              { type: 'text', text: '看看这张图' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AAAA' },
              },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/img.png' },
              },
            ] as any,
          }),
        ],
      }),
    )

    expect(html).not.toContain('class="message-images"')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data:image')
    expect(html).not.toContain('example.com/img.png')
    // 正文照常
    expect(html).toContain('看看这张图')
  })

  it('只有图片（没有别的可见内容）的消息不产空气泡', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AAAA' },
              },
            ] as any,
          }),
        ],
      }),
    )

    expect(html).not.toContain('class="message-bubble')
  })
})

describe('sessionToHtml — 工具调用（行模型与聊天区同源）', () => {
  it('只有一次工具调用时保持单卡（不套折叠组）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'read_file', { path: 'C:/a/b.ts' }, '我先看一下'),
          makeMessage({ role: 'tool', content: '📄 b.ts 共 10 行', toolCallId: 'c1' }),
        ],
      }),
    )

    // 单卡：无折叠组
    expect(html).not.toContain('<details class="tool-group"')
    expect(html).toContain('<details class="tool-call is-done">')
    // 行：状态点 + 工具名 + 摘要 + 箭头
    expect(html).toContain('<span class="tool-call__point done"></span>')
    expect(html).toContain('<span class="tool-call__label">read_file</span>')
    expect(html).toContain(
      '<span class="tool-call__short" title="C:/a/b.ts">C:/a/b.ts</span>',
    )
    expect(html).toContain('tool-call__caret')
    // 段首宿主的正文显示在组头之上（不随折叠隐藏）
    const body = html.slice(html.indexOf('<div class="chat-messages">'))
    expect(body).toContain('<div class="message-bubble assistant">')
    expect(body).toContain('我先看一下')
    expect(body.indexOf('我先看一下')).toBeLessThan(
      body.indexOf('tool-call__label'),
    )
  })

  it('展开视图里是「参数 + 返回」（通用详情，不复刻每个工具自己的展开视图）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'web_search', { query: '天气' }),
          makeMessage({ role: 'tool', content: '晴天 25°C', toolCallId: 'c1' }),
        ],
      }),
    )

    expect(html).toContain('<div class="tool-call__view">')
    expect(html).toContain('<div class="tool-call__field">工具调用参数</div>')
    expect(html).toContain('&quot;query&quot;: &quot;天气&quot;')
    expect(html).toContain('<div class="tool-call__field">工具返回</div>')
    expect(html).toContain('<pre class="tool-call__code">晴天 25°C</pre>')
  })

  it('展开视图超过 50vh 时内部滚动（样式里钉住）', () => {
    const html = toHtml(makeSession())
    const view = html.slice(
      html.indexOf('.tool-call__view {'),
      html.indexOf('.tool-call__field {'),
    )
    expect(view).toContain('max-height: 50vh')
    expect(view).toContain('overflow: auto')
  })

  it('工具还在跑（没有结果）时状态点是 pending，视图里说明暂无详情', () => {
    const html = toHtml(
      makeSession({ messages: [toolCallMessage('c1', 'shell', { cmd: 'ls' })] }),
    )

    expect(html).toContain('<details class="tool-call is-pending">')
    expect(html).toContain('<span class="tool-call__point pending"></span>')
    expect(html).toContain('暂无详情')
  })

  it('工具失败时状态点是 error 并带失败标记', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'shell', { cmd: 'boom' }),
          makeMessage({
            role: 'tool',
            content: '执行超时',
            toolCallId: 'c1',
            isError: true,
          }),
        ],
      }),
    )

    expect(html).toContain('<details class="tool-call is-error">')
    expect(html).toContain('<span class="tool-call__point error"></span>')
    expect(html).toContain('tool-call__error')
    expect(html).toContain('执行失败')
    expect(html).toContain('ID: c1')
    expect(html).toContain('执行超时')
  })

  it('结果耗时超过 1 秒时展示在行上', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'shell', { cmd: 'ls' }),
          makeMessage({
            role: 'tool',
            content: 'ok',
            toolCallId: 'c1',
            elapsedMs: 2400,
          }),
        ],
      }),
    )

    expect(html).toContain('<span class="tool-call__timing">2.4s</span>')
  })

  it('工具返回值只出现一次（回填进卡片，不另外成块）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'shell', { cmd: 'ls' }),
          makeMessage({ role: 'tool', content: 'UNIQUE_TOOL_OUTPUT', toolCallId: 'c1' }),
        ],
      }),
    )

    expect(count(html, 'UNIQUE_TOOL_OUTPUT')).toBe(1)
    // role:'tool' 的消息不单独成行、也不产生气泡
    expect(count(html, 'class="message-bubble')).toBe(0)
  })

  it('连续多次工具调用合成一个折叠组，后面有正文时默认折叠', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'read_file', { path: 'a' }),
          makeMessage({ role: 'tool', content: 'A 的内容', toolCallId: 'c1' }),
          toolCallMessage('c2', 'read_file', { path: 'b' }),
          makeMessage({ role: 'tool', content: 'B 的内容', toolCallId: 'c2' }),
          makeMessage({ role: 'assistant', content: '看完了' }),
        ],
      }),
    )

    // 两条 assistant 的调用合成一组
    expect(count(html, '<details class="tool-group"')).toBe(1)
    expect(html).toContain('2 次工具调用')
    // 工具名去重后预览
    expect(html).toContain('<span class="tool-group__tools" title="read_file">')
    // 后面有正文 → 默认折叠（无 open）
    expect(html).toContain('<details class="tool-group">')
    expect(html).not.toContain('<details class="tool-group" open>')
    // 两次调用各一张卡片，且都在组体内
    expect(count(html, '<details class="tool-call ')).toBe(2)
    expect(html).toContain('A 的内容')
    expect(html).toContain('B 的内容')
  })

  it('一段工具调用之后没有正文时（尾部段）默认展开', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'user', content: '开始吧' }),
          toolCallMessage('c1', 'shell', { cmd: 'ls' }),
          makeMessage({ role: 'tool', content: 'a.txt', toolCallId: 'c1' }),
          toolCallMessage('c2', 'shell', { cmd: 'pwd' }),
          makeMessage({ role: 'tool', content: '/tmp', toolCallId: 'c2' }),
        ],
      }),
    )

    expect(html).toContain('<details class="tool-group" open>')
  })

  it('折叠头最多预览 3 个工具名，多出来的折成 +N', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCalls: [
              { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
              { type: 'tool_use', id: 'c2', name: 'search_text_in_files', input: {} },
              { type: 'tool_use', id: 'c3', name: 'list_files', input: {} },
              { type: 'tool_use', id: 'c4', name: 'execute_command', input: {} },
            ],
          }),
        ],
      }),
    )

    expect(html).toContain('4 次工具调用')
    expect(html).toContain(
      'read_file · search_text_in_files · list_files +1',
    )
    // 没有可见内容 → 不产生空气泡
    expect(html).not.toContain('class="message-bubble')
  })

  it('中段带正文的宿主会收口（正文是看得见的边界）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'shell', { cmd: 'a' }),
          makeMessage({ role: 'tool', content: 'A', toolCallId: 'c1' }),
          toolCallMessage('c2', 'shell', { cmd: 'b' }, '中间这句是正文'),
          makeMessage({ role: 'tool', content: 'B', toolCallId: 'c2' }),
        ],
      }),
    )

    // 两段各自只有一次调用 → 都是单卡，不合成一组
    expect(html).not.toContain('<details class="tool-group"')
    expect(count(html, '<details class="tool-call ')).toBe(2)
  })

  it('找不到宿主的工具结果单独成卡（内容不丢）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'tool',
            content: 'ORPHAN_OUTPUT',
            toolCallId: 'missing',
          }),
        ],
      }),
    )

    expect(html).toContain('<details class="tool-call is-orphan">')
    expect(html).toContain('工具返回')
    expect(html).toContain('ORPHAN_OUTPUT')
  })

  it('omitToolCalls=true 时工具卡片与返回结果都不导出', () => {
    const html = toHtml(
      makeSession({
        messages: [
          toolCallMessage('c1', 'read_file', { path: 'a.ts' }, '让我查一下'),
          makeMessage({ role: 'tool', content: '📄 a.ts 共 196 行', toolCallId: 'c1' }),
        ],
      }),
      { omitToolCalls: true },
    )

    expect(html).not.toContain('<details class="tool-call ')
    expect(html).not.toContain('read_file')
    expect(html).not.toContain('📄 a.ts')
    // 宿主的正文仍保留
    expect(html).toContain('让我查一下')
  })

  it('两个选项同时开启时，思考与工具调用都不导出', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'assistant',
            content: '结论如下',
            reasoningContent: '先想一下',
            toolCalls: [{ type: 'tool_use', id: 'c1', name: 'shell', input: { cmd: 'ls' } }],
          }),
          makeMessage({ role: 'tool', content: '文件列表', toolCallId: 'c1' }),
        ],
      }),
      { omitToolCalls: true, omitThinking: true },
    )

    expect(html).toContain('结论如下')
    expect(html).not.toContain('<details class="reasoning-block"')
    expect(html).not.toContain('先想一下')
    expect(html).not.toContain('<details class="tool-call ')
    expect(html).not.toContain('文件列表')
  })
})

describe('sessionToHtml — 摘要与反馈', () => {
  it('上下文压缩摘要渲染成可展开的卡片（点开看全文）', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'summary',
            content: '用户询问了关于天气的问题',
            uiData: { compressMode: 'raw', contextTokens: 12500 },
          }),
        ],
      }),
    )

    expect(html).toContain('<div class="message-compress-summary">')
    expect(html).toContain('<details class="compress-summary-card">')
    expect(html).toContain('上下文已压缩')
    expect(html).toContain('正文压缩')
    expect(html).toContain('压缩后约 12.5k tokens')
    expect(html).toContain('<div class="compress-summary-body">')
    expect(html).toContain('天气')
  })

  it('反馈消息渲染成居中卡片', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'feedback', content: '**校验失败**，请修正' }),
        ],
      }),
    )

    expect(html).toContain('<div class="message-feedback">')
    expect(html).toContain('<div class="feedback-content">')
    expect(html).toContain('校验失败')
  })

  // 工具把图片交给模型时注入的 `vision_image` 消息：它只是持久化载体，导出里一条都不写
  // （连 data URL 也不能进 HTML，否则单文件会凭空大几 MB）
  it('vision_image 注入消息不导出', () => {
    const html = toHtml(
      makeSession({
        messages: [
          makeMessage({ role: 'user', content: '看下这张截图' }),
          makeMessage({
            role: 'vision_image',
            content: [
              { type: 'text', text: 'Image "shot.png" (/w/shot.png)' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,QUJD' },
              },
            ],
          }),
        ],
      }),
    )

    expect(html).toContain('看下这张截图')
    expect(html).not.toContain('data:image/png;base64')
    expect(html).not.toContain('shot.png')
  })
})

describe('sessionToHtml — 转义', () => {
  it('标题、工具参数、工具输出、文件路径、引用正文都会被转义', () => {
    const html = toHtml(
      makeSession({
        title: '<script>alert(1)</script>',
        messages: [
          toolCallMessage('c1', 'shell', { cmd: '</pre><img onerror=x>' }),
          makeMessage({
            role: 'tool',
            content: '<img src=x onerror=alert(1)>',
            toolCallId: 'c1',
          }),
          makeMessage({
            role: 'user',
            content: [
              { type: 'quote', role: 'user', text: '<b>引用</b>' },
              { type: 'file', path: 'C:/a/<x>.ts' },
            ] as any,
          }),
        ],
      }),
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('&lt;/pre&gt;&lt;img onerror=x&gt;')
    expect(html).not.toContain('onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<b>引用</b>')
    expect(html).toContain('&lt;b&gt;引用&lt;/b&gt;')
    expect(html).toContain('C:/a/&lt;x&gt;.ts')
  })
})

describe('createMarkdownHtmlRenderer', () => {
  it('复用 react-markdown 渲染链：标题/列表/表格/代码块都转成 HTML，原始 HTML 只当文本', async () => {
    const render = await createMarkdownHtmlRenderer()
    const html = sessionToHtml(
      makeSession({
        messages: [
          makeMessage({
            role: 'assistant',
            content: [
              '## 结论',
              '',
              '**粗体** 与 `code`',
              '',
              '- 一',
              '- 二',
              '',
              '| 列 | 值 |',
              '| --- | --- |',
              '| a | 1 |',
              '',
              '```js',
              'const a = 1',
              '```',
              '',
              '<script>alert(1)</script>',
            ].join('\n'),
          }),
        ],
      }),
      render,
    )

    expect(html).toContain('<h2>结论</h2>')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<li>一</li>')
    // 表格套一层横向滚动容器（与聊天区 MarkdownRenderer 同款）
    expect(html).toContain('<div class="table-wrapper"><table>')
    expect(html).toContain('<pre>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // 正文已经不是 Markdown 原文
    expect(html).not.toContain('## 结论')
  })
})
