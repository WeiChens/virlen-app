/**
 * summary-message 渲染回归 — 上下文压缩产物在消息列表里的呈现
 *
 * 钉住的契约：
 * - 列表态**只**渲染提示条，摘要正文一律不进消息流（正文压缩产物可达数万字符，
 *   铺开会让虚拟列表的测量与 Markdown 渲染成本飙升）；
 * - 摘要全文只在弹窗里渲染；
 * - 只有正文压缩（compressMode='raw'）才展示「压缩后约 N tokens」——
 *   AI 摘要的 usage 是那次调用的消耗，不是压缩后的上下文大小，展示会误导。
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SummaryMessage, {
  SummaryModal,
} from '@/ui/pages/chat/components/message/summary-message'
import type { Message } from '@/types'

// 真实 MarkdownRenderer 会静态引入 monaco（CodeBlock），而 jsdom 没有 CSS.escape，
// 导入即崩。这里只关心「文本出现在列表还是弹窗」，把渲染器换成直出文本的替身。
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="mock-md">{content}</div>
  ),
}))

const SUMMARY_BODY = 'SUMMARY_BODY_ONLY_IN_MODAL'

function makeSummary(overrides: Partial<Message> = {}): Message {
  return {
    id: 'summary-1',
    role: 'summary',
    content: SUMMARY_BODY,
    timestamp: 1700000000000,
    ...overrides,
  }
}

describe('SummaryMessage 压缩产物条目', () => {
  it('列表态只渲染提示条，不铺开摘要正文', () => {
    const html = renderToStaticMarkup(
      <SummaryMessage message={makeSummary()} />,
    )
    expect(html).toContain('compress-summary-card')
    expect(html).toContain('上下文已压缩')
    expect(html).not.toContain(SUMMARY_BODY)
  })

  it('弹窗态渲染摘要全文', () => {
    const html = renderToStaticMarkup(
      <SummaryModal visible message={makeSummary()} onClose={() => {}} />,
    )
    expect(html).toContain('上下文压缩摘要')
    expect(html).toContain(SUMMARY_BODY)
  })

  it('正文压缩展示压缩后估算占用与压缩方式', () => {
    const html = renderToStaticMarkup(
      <SummaryModal
        visible
        message={makeSummary({
          uiData: { compressMode: 'raw', contextTokens: 12500 },
        })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('正文压缩')
    expect(html).toContain('12.5k')
  })

  it('AI 摘要不展示上下文占用（那是调用消耗，不是压缩后大小）', () => {
    const html = renderToStaticMarkup(
      <SummaryModal
        visible
        message={makeSummary({
          uiData: { compressMode: 'ai' },
          usage: {
            promptTokens: 900,
            completionTokens: 100,
            totalTokens: 1000,
          },
        })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('AI 摘要')
    expect(html).not.toContain('tokens')
  })

  it('空摘要兜底显示占位，而不是一片空白', () => {
    const html = renderToStaticMarkup(
      <SummaryModal
        visible
        message={makeSummary({ content: '' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('（无内容）')
  })
})
