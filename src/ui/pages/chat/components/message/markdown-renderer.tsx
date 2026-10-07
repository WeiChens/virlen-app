// @ts-nocheck
/**
 * Markdown 渲染（react-markdown + remark-gfm，代码高亮交给 `CodeBlock`）。
 *
 * ⚡ 流式性能两级：① rAF 节流把高频 chunk 合并到每帧一次；② 前缀冻结 —— 把「已定稿的块」与「正在增长的
 * 尾部」拆成两棵子树（见 `splitStablePrefix`），前缀被 memo 冻住，内容不变时整棵跳过 reconcile，每帧只重建
 * 尾部。此前每帧 reconcile 整篇文档是主要 CPU 来源；消息结束时整篇一次性渲染，保证最终结果不变。
 */
import { memo, useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './code-block'
import { splitStablePrefix } from './streamMarkdown'
import './markdown-renderer.scss'

/** 稳定的 remark 插件数组（避免每次渲染新建数组） */
const REMARK_PLUGINS = [remarkGfm]

/**
 * rAF 节流 content：streaming 时每帧最多更新一次（高频 content 变化被合并）；非 streaming 立即更新并取消 pending rAF。
 */
function useThrottledContent(content: string, streaming?: boolean): string {
  const [displayContent, setDisplayContent] = useState(content)
  const rafRef = useRef<number | null>(null)
  const latestRef = useRef(content)

  useEffect(() => {
    latestRef.current = content

    if (streaming) {
      // 流式模式：用 rAF 节流，只调度一次
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          setDisplayContent(latestRef.current)
        })
      }
    } else {
      // 非流式（已完成）：立即更新，取消 pending rAF
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      setDisplayContent(content)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, streaming])

  // 卸载时清理
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return displayContent
}

interface Props {
  content: string
  isUser?: boolean
  streaming?: boolean
}

function LinkRenderer({ href, children, ...props }: any) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="md-link"
      {...props}>
      {children}
    </a>
  )
}

/**
 * 纯渲染体：props 只有两个基本类型，内容不变时 memo 命中、React 整棵跳过（这正是「前缀冻结」能省掉
 * reconcile 的原因）。components 用 useMemo 按 streaming 缓存，保证引用稳定。
 */
const MarkdownBody = memo(function MarkdownBody({
  content,
  streaming,
}: {
  content: string
  streaming?: boolean
}) {
  const components = useMemo(
    () => ({
      code: (props: any) => <CodeBlock inlineCode {...props} streaming={streaming} />,
      a: LinkRenderer as any,
      table: ({ children, ...props }: any) => (
        <div className="table-wrapper">
          <table {...props}>{children}</table>
        </div>
      ),
      ul: ({ children, ...props }: any) => (
        <ul className="md-ul" {...props}>
          {children}
        </ul>
      ),
      ol: ({ children, ...props }: any) => (
        <ol className="md-ol" {...props}>
          {children}
        </ol>
      ),
      li: ({ children, ...props }: any) => (
        <li className="md-li" {...props}>
          {children}
        </li>
      ),
      blockquote: ({ children, ...props }: any) => (
        <blockquote className="md-blockquote" {...props}>
          {children}
        </blockquote>
      ),
      h1: ({ children, ...props }: any) => (
        <h1 className="md-h1" {...props}>
          {children}
        </h1>
      ),
      h2: ({ children, ...props }: any) => (
        <h2 className="md-h2" {...props}>
          {children}
        </h2>
      ),
      h3: ({ children, ...props }: any) => (
        <h3 className="md-h3" {...props}>
          {children}
        </h3>
      ),
      h4: ({ children, ...props }: any) => (
        <h4 className="md-h4" {...props}>
          {children}
        </h4>
      ),
      hr: (props: any) => <hr className="md-hr" {...props} />,
      p: ({ children, ...props }: any) => (
        <p className="md-p" {...props}>
          {children}
        </p>
      ),
    }),
    [streaming],
  )

  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {content}
    </ReactMarkdown>
  )
})

/** Markdown 渲染入口（用户消息不走 Markdown，直接原样输出）。 */
export default memo(function MarkdownRenderer({
  content,
  isUser,
  streaming,
}: Props) {
  // rAF 节流：避免流式高频更新导致 ReactMarkdown 重复解析
  const displayContent = useThrottledContent(content, streaming)

  if (isUser) {
    return <>{displayContent}</>
  }

  // 流式隔离：已定稿前缀冻结，每帧只重建尾部
  if (streaming) {
    const [prefix, tail] = splitStablePrefix(displayContent)
    if (prefix) {
      return (
        <div className="markdown-renderer">
          <MarkdownBody content={prefix} streaming={streaming} />
          <MarkdownBody content={tail} streaming={streaming} />
        </div>
      )
    }
  }

  return (
    <div className="markdown-renderer">
      <MarkdownBody content={displayContent} streaming={streaming} />
    </div>
  )
})
