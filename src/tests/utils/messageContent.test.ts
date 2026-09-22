/**
 * messageContent — 用户消息 content 组装 / 解析测试
 *
 * 重点守住两条不变量：
 *   1. 文件附件只带路径，绝不带文件内容（"不拷贝文件"是产品约定）
 *   2. 文本/图片的既有行为不被文件附件改变（回归保护）
 * 再补一条与之相反的不变量：
 *   3. 技能引用**必须**带 SKILL.md 全文（"引用技能"的语义就是把说明交给模型）
 */
import { describe, it, expect } from 'vitest'
import {
  buildUserContent,
  getFileBlocks,
  getImageUrls,
  getQuoteBlocks,
  getSkillBlocks,
  fileBlocksToText,
} from '@/utils/messageContent'
import { fileBlockToText, quoteBlockToText, skillBlockToText } from '@/types'

const img = (n: number) => ({ url: `data:image/png;base64,IMG${n}` })

const quote = (messageId: string, role: 'user' | 'assistant', text: string) => ({
  messageId,
  role,
  text,
})

describe('buildUserContent', () => {
  it('纯文本：只产生一个 text 块', () => {
    expect(buildUserContent('你好')).toEqual([{ type: 'text', text: '你好' }])
  })

  it('文本 + 图片：text 在校首，image_url 依次在后', () => {
    const content = buildUserContent('看看', [img(1), img(2)]) as any[]
    expect(content.map((b) => b.type)).toEqual(['text', 'image_url', 'image_url'])
    expect(content[1].image_url.url).toBe('data:image/png;base64,IMG1')
  })

  it('文本 + 文件：文件块只带路径，不带任何文件内容', () => {
    const content = buildUserContent('读一下', [], [
      { path: 'C:/a/b.ts', name: 'b.ts', size: 12 },
    ]) as any[]

    expect(content).toEqual([
      { type: 'text', text: '读一下' },
      { type: 'file', path: 'C:/a/b.ts', name: 'b.ts', isDir: undefined, size: 12 },
    ])
    // 关键：块里除了路径与展示元数据，不应出现任何内容字段
    const fileBlock = content[1]
    expect(Object.keys(fileBlock).sort()).toEqual([
      'isDir',
      'name',
      'path',
      'size',
      'type',
    ])
  })

  it('无文本但有图片：沿用「分析这张/这N张图片」的兜底文案', () => {
    const one = buildUserContent('', [img(1)]) as any[]
    expect(one[0]).toEqual({ type: 'text', text: '分析这张图片' })

    const two = buildUserContent('', [img(1), img(2)]) as any[]
    expect(two[0]).toEqual({ type: 'text', text: '分析这2张图片' })
  })

  it('无文本但有文件：补一句「看看这些文件」，文件块仍只有路径', () => {
    const content = buildUserContent('', [], [{ path: '/tmp/a.txt' }]) as any[]
    expect(content[0]).toEqual({ type: 'text', text: '看看这些文件' })
    expect(content[1].type).toBe('file')
    expect(content[1].path).toBe('/tmp/a.txt')
  })

  it('空输入：返回空数组（不产生空 text 块）', () => {
    expect(buildUserContent('')).toEqual([])
    expect(buildUserContent('', [], [])).toEqual([])
  })

  it('三类附件混排：text → image → file', () => {
    const content = buildUserContent('干活', [img(1)], [
      { path: 'C:/a.ts' },
      { path: 'C:/dir', isDir: true },
    ]) as any[]
    expect(content.map((b) => b.type)).toEqual([
      'text',
      'image_url',
      'file',
      'file',
    ])
    expect(content[3].isDir).toBe(true)
  })
})

describe('getFileBlocks / getImageUrls', () => {
  it('字符串 content 不报错并返回空', () => {
    expect(getFileBlocks('plain')).toEqual([])
    expect(getImageUrls('plain')).toEqual([])
  })

  it('按类型筛出文件块与图片 url', () => {
    const content = buildUserContent('x', [img(1)], [{ path: 'C:/a.ts' }])
    expect(getFileBlocks(content).map((f) => f.path)).toEqual(['C:/a.ts'])
    expect(getImageUrls(content)).toEqual(['data:image/png;base64,IMG1'])
  })
})

describe('fileBlockToText', () => {
  // 这里故意断言字面量（而不是引用常量）：常量被改时要红，
  // 提醒同步 Rust 侧 provider.rs 的同名常量（铁律 1：双引擎文案一致）
  it('文件与目录给出不同标签，且只含路径', () => {
    expect(fileBlockToText({ type: 'file', path: 'C:/a.ts' })).toBe(
      '[User attached file] C:/a.ts',
    )
    expect(
      fileBlockToText({ type: 'file', path: 'C:/dir', isDir: true }),
    ).toBe('[User attached folder] C:/dir')
  })

  it('path 缺失时不产生 undefined 字面量', () => {
    expect(fileBlockToText({ type: 'file', path: '' })).toBe(
      '[User attached file] ',
    )
  })

  it('fileBlocksToText 逐行拼接', () => {
    expect(
      fileBlocksToText([
        { type: 'file', path: '/a' },
        { type: 'file', path: '/b' },
      ]),
    ).toBe('[User attached file] /a\n[User attached file] /b')
  })
})

// ==================== 引用消息 ====================

describe('buildUserContent + 引用', () => {
  it('引用块在最前，正文紧随其后（引用是「本条消息针对的对象」）', () => {
    const content = buildUserContent('继续', [], [], [
      quote('m-1', 'assistant', '上一轮结论'),
    ]) as any[]

    expect(content.map((b) => b.type)).toEqual(['quote', 'text'])
    expect(content[0]).toEqual({
      type: 'quote',
      messageId: 'm-1',
      role: 'assistant',
      text: '上一轮结论',
    })
    expect(content[1]).toEqual({ type: 'text', text: '继续' })
  })

  it('引用块字段白名单：不含除了来源与正文快照以外的任何字段', () => {
    const content = buildUserContent('x', [], [], [
      quote('m-1', 'user', '原文'),
    ]) as any[]
    expect(Object.keys(content[0]).sort()).toEqual([
      'messageId',
      'role',
      'text',
      'type',
    ])
  })

  it('仅引用无正文：补一句「请针对引用的消息回复」', () => {
    const content = buildUserContent('', [], [], [
      quote('m-1', 'user', '原文'),
    ]) as any[]
    expect(content.map((b) => b.type)).toEqual(['quote', 'text'])
    expect(content[1].text).toBe('请针对引用的消息回复')
  })

  it('多条引用按传入顺序保留', () => {
    const content = buildUserContent('汇总', [], [], [
      quote('m-1', 'user', 'A'),
      quote('m-2', 'assistant', 'B'),
    ]) as any[]
    expect(content.map((b) => b.messageId)).toEqual([
      'm-1',
      'm-2',
      undefined,
    ])
  })

  it('四类内容混排：quote → text → image → file', () => {
    const content = buildUserContent('干活', [img(1)], [{ path: 'C:/a.ts' }], [
      quote('m-1', 'assistant', 'B'),
    ]) as any[]
    expect(content.map((b) => b.type)).toEqual([
      'quote',
      'text',
      'image_url',
      'file',
    ])
  })

  it('不传 quotes 时行为与旧版一致（向后兼容）', () => {
    expect(buildUserContent('你好')).toEqual([{ type: 'text', text: '你好' }])
  })
})

describe('getQuoteBlocks', () => {
  it('字符串 content 不报错并返回空', () => {
    expect(getQuoteBlocks('plain')).toEqual([])
  })

  it('筛出引用块，忽略其他块', () => {
    const content = buildUserContent('x', [img(1)], [{ path: 'C:/a.ts' }], [
      quote('m-1', 'user', '原文'),
    ])
    const blocks = getQuoteBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].messageId).toBe('m-1')
    expect(blocks[0].text).toBe('原文')
  })
})

describe('quoteBlockToText', () => {
  // 这里故意断言字面量（而不是引用常量）：常量被改时要红，
  // 提醒同步 Rust 侧 provider.rs 的同名常量（铁律 1：双引擎文案一致）
  it('发送方 / 消息 id / 正文三段齐全', () => {
    expect(
      quoteBlockToText({
        type: 'quote',
        messageId: 'm-1',
        role: 'assistant',
        text: '上一轮结论',
      }),
    ).toBe(
      '[Quoted message]\nSender: assistant\nMessage ID: m-1\nContent:\n上一轮结论',
    )
  })

  it('多行正文原样保留（不做折叠 / 转义）', () => {
    expect(
      quoteBlockToText({
        type: 'quote',
        messageId: 'm-2',
        role: 'user',
        text: '第一行\n第二行',
      }),
    ).toBe(
      '[Quoted message]\nSender: user\nMessage ID: m-2\nContent:\n第一行\n第二行',
    )
  })
})

// ==================== 技能引用 ====================

const skill = (name: string, path: string, content: string) => ({
  name,
  path,
  content,
})

describe('buildUserContent + 技能引用', () => {
  it('技能块在引用之后、正文之前（都是给模型的上下文，先上下文后指令）', () => {
    const content = buildUserContent(
      '用它审查',
      [],
      [],
      [quote('m-1', 'assistant', '上一轮结论')],
      [skill('code-reviewer', 'C:/skills/code-reviewer', '# 规则')],
    ) as any[]

    expect(content.map((b) => b.type)).toEqual(['quote', 'skill', 'text'])
    expect(content[1]).toEqual({
      type: 'skill',
      name: 'code-reviewer',
      path: 'C:/skills/code-reviewer',
      content: '# 规则',
    })
  })

  it('技能块字段白名单：技能名 + 目录 + 全文快照，不带其他字段', () => {
    const content = buildUserContent('x', [], [], [], [
      skill('code-reviewer', 'C:/skills/code-reviewer', '# 规则'),
    ]) as any[]
    expect(Object.keys(content[0]).sort()).toEqual([
      'content',
      'name',
      'path',
      'type',
    ])
  })

  it('带 description 时原样落到技能块（气泡卡片正文用）', () => {
    const content = buildUserContent('x', [], [], [], [
      {
        ...skill('code-reviewer', 'C:/skills/code-reviewer', '# 规则'),
        description: '审查代码',
      },
    ]) as any[]
    expect(content[0].description).toBe('审查代码')
  })

  it('description 为空时不落字段（不在库里 / 请求体里堆空字段）', () => {
    const content = buildUserContent('x', [], [], [], [
      { ...skill('code-reviewer', 'C:/skills', '# 规则'), description: '' },
    ]) as any[]
    expect('description' in content[0]).toBe(false)
  })

  it('全文原样带上（SKILL.md 较长时不被截断 / 不转义）', () => {
    const md = '# 审查规则\n\n1. 先看边界\n2. 再看好坏\n\n```ts\nconst a = 1\n```\n'
    const content = buildUserContent('x', [], [], [], [
      skill('reviewer', 'C:/skills/reviewer', md),
    ]) as any[]
    expect(content[0].content).toBe(md)
  })

  it('仅技能无正文：补一句「请参考我引用的技能」', () => {
    const content = buildUserContent('', [], [], [], [
      skill('code-reviewer', 'C:/skills/code-reviewer', '# 规则'),
    ]) as any[]
    expect(content.map((b) => b.type)).toEqual(['skill', 'text'])
    expect(content[1].text).toBe('请参考我引用的技能')
  })

  it('五个参数全给：quote → skill → text → image → file', () => {
    const content = buildUserContent(
      '干活',
      [img(1)],
      [{ path: 'C:/a.ts' }],
      [quote('m-1', 'assistant', 'B')],
      [skill('reviewer', 'C:/skills/reviewer', '# 规则')],
    ) as any[]
    expect(content.map((b) => b.type)).toEqual([
      'quote',
      'skill',
      'text',
      'image_url',
      'file',
    ])
  })

  it('不传 skills 时行为与旧版一致（向后兼容）', () => {
    expect(buildUserContent('你好')).toEqual([{ type: 'text', text: '你好' }])
  })
})

describe('getSkillBlocks', () => {
  it('字符串 content 不报错并返回空', () => {
    expect(getSkillBlocks('plain')).toEqual([])
  })

  it('筛出技能块，忽略其他块', () => {
    const content = buildUserContent('x', [], [{ path: 'C:/a.ts' }], [], [
      skill('reviewer', 'C:/skills/reviewer', '# 规则'),
    ])
    const blocks = getSkillBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].name).toBe('reviewer')
    expect(blocks[0].content).toBe('# 规则')
  })
})

describe('skillBlockToText', () => {
  // 这里故意断言字面量（而不是引用常量）：常量被改时要红，
  // 提醒同步 Rust 侧 provider.rs 的同名常量（铁律 1：双引擎文案一致）
  it('四个字段恒定输出，SKILL.md 全文在最后', () => {
    expect(
      skillBlockToText({
        type: 'skill',
        name: 'code-reviewer',
        path: 'C:/skills/code-reviewer',
        content: '# 审查规则\n先看边界。',
      }),
    ).toBe(
      '[Skill]\nName: code-reviewer\nDirectory: C:/skills/code-reviewer\nSKILL.md:\n# 审查规则\n先看边界。',
    )
  })

  it('缺失字段退化为空值，不产生 undefined 字面量', () => {
    expect(
      skillBlockToText({ type: 'skill', name: '', content: '' }),
    ).toBe('[Skill]\nName: \nDirectory: \nSKILL.md:\n')
  })

  it('description 不进降级文本（它只给 UI 看，Rust 侧同样不读）', () => {
    expect(
      skillBlockToText({
        type: 'skill',
        name: 'code-reviewer',
        path: 'C:/skills/code-reviewer',
        description: '审查代码',
        content: '# 规则',
      }),
    ).toBe(
      '[Skill]\nName: code-reviewer\nDirectory: C:/skills/code-reviewer\nSKILL.md:\n# 规则',
    )
  })
})
