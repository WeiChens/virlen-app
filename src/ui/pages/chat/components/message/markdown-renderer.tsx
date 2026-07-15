// @ts-nocheck
/**
 * MarkdownRenderer — Markdown 渲染
 *
 * 使用 react-markdown + remark-gfm 渲染 Markdown
 * 代码高亮由独立的 CodeBlock 组件处理。
 *
 * ⚡ 性能优化：流式输出时通过 requestAnimationFrame 节流，
 * 将 ReactMarkdown 的解析/渲染频率限制在帧率级别（~60fps），
 * 避免高频 chunk 更新导致的性能瓶颈。
 */
import { memo, useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './code-block'
import './markdown-renderer.scss'

// ==================== Hook：rAF 节流 ====================

/**
 * 使用 requestAnimationFrame 对 content 进行节流。
 *
 * - streaming=true：只在每帧 (raf) 更新一次 displayContent，高频 content 变化被合并
 * - streaming=false：立即更新，取消 pending raf，确保最终结果准确
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

// ==================== 组件 ====================

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
 * MarkdownRenderer — 渲染 Markdown 内容
 */
export default memo(function MarkdownRenderer({
  content,
  isUser,
  streaming,
}: Props) {
  // ---- rAF 节流：避免流式高频更新导致 ReactMarkdown 重复解析 ----
  const displayContent = useThrottledContent(content, streaming)

  if (isUser) {
    return <>{displayContent}</>
  }

  return (
    <div className="markdown-renderer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: (props: any) => <CodeBlock {...props} streaming={streaming} />,
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
        }}>
        {displayContent}
      </ReactMarkdown>
      {/* {streaming && <span className="cursor-blink"></span>} */}
    </div>
  )
})
