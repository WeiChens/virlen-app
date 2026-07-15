import { fetch } from '@tauri-apps/plugin-http'
import { timeoutWithSignal } from '@/utils/withCancel'
import { ToolContext, ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'

const MAX_LENGTH = 20_000
/** 懒加载 cheerio + turndown，避免 F5 刷新时解析 240KB+ JS 阻塞主线程 */
let _turndownService: any = null
let _cheerio: any = null
async function ensureHtmlDeps(): Promise<{ cheerio: any; turndown: any }> {
  if (!_cheerio) _cheerio = await import('cheerio')
  if (!_turndownService) {
    const mod = await import('turndown')
    _turndownService = new mod.default()
  }
  return { cheerio: _cheerio, turndown: _turndownService }
}

toolRegistry.register(
  {
    name: 'web_fetch',
    label: t('网页抓取'),
    description: 'Fetch a URL. Returns Markdown (if htmlToMd=true).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        method: {
          type: 'string',
          description: 'HTTP method (GET, POST, etc.)',
          default: 'GET',
        },
        body: {
          type: 'string',
          description: 'Request body for POST/PUT requests',
        },
        htmlToMd: {
          type: 'boolean',
          description: 'Convert HTML to Markdown',
          default: true,
        },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds. Default: 10.',
          default: 10,
        },
      },
      required: ['url'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    const method = args.method || 'GET'
    const reqBody = args.body || null
    const htmlToMd = args.htmlToMd ?? true
    const timeoutSeconds = (args.timeout as number) ?? 10
    const timeoutMs = timeoutSeconds * 1000
    const { signal, cancel } = timeoutWithSignal(timeoutMs, ctx.abortSignal)

    /**
     * 检查当前是否已被取消（用户在点击"停止"后触发 ctx.abortSignal）
     * 在 fetch 完成后的每个处理步骤中调用，确保能及时终止
     */
    function checkAborted(): void {
      if (signal.aborted || ctx.abortSignal.aborted) {
        throw new Error(`web_fetch was cancelled: ${args.url}`)
      }
    }

    let response: Response
    try {
      // 用 Promise 包装，在 JS 层面直接监听 signal abort 并 reject，
      // 不依赖 @tauri-apps/plugin-http Rust 端的取消传播
      response = await new Promise<Response>((resolve, reject) => {
        // 同步检查：如果 signal 已经 aborted，直接拒绝
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }

        const onAbort = () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })

        fetch(args.url, {
          method,
          body: reqBody,
          signal,
        })
          .then((res) => {
            signal.removeEventListener('abort', onAbort)
            if (signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            resolve(res)
          })
          .catch((err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          })
      })
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        if (e.message === 'Aborted') {
          throw new Error(`web_fetch was cancelled: ${args.url}`)
        }
        throw new Error(
          `web_fetch timed out after ${timeoutSeconds}s: ${args.url}`,
        )
      }
      throw new Error(`web_fetch failed: ${e.message || String(e)}`)
    }

    // ---- 1. 检查 Content-Type，拒绝明显的非文本响应 ----
    checkAborted()
    const contentType = response.headers.get('content-type') || ''
    const binaryTypes = [
      'application/octet-stream',
      'application/pdf',
      'application/zip',
      'application/gzip',
      'application/x-',
      'image/',
      'audio/',
      'video/',
      'font/',
      'application/vnd',
    ]
    const normalizedCt = contentType.toLowerCase()
    const isBinaryType = binaryTypes.some((t) => normalizedCt.startsWith(t))
    if (isBinaryType) {
      throw new Error(
        `web_fetch: response has binary Content-Type "${contentType}" for ${args.url}. ` +
          `This tool only supports text-based responses (HTML, JSON, XML, plain text, etc.).`,
      )
    }

    // ---- 2. 读取响应体 ----
    checkAborted()
    let result: string
    try {
      result = await response.text()
    } catch (e: any) {
      throw new Error(
        `web_fetch failed to read response body: ${e.message || String(e)}`,
      )
    }

    // ---- 3. HTML 转 Markdown（最耗时的步骤）----
    checkAborted()
    if (htmlToMd && isHtml(result)) {
      const { cheerio, turndown } = await ensureHtmlDeps()
      const $ = cheerio.load(result)
      $('script, style, .hidden, footer, header, iframe, noscript').remove()
      const text = $.html()

      checkAborted()
      result = turndown.turndown(text)
    }

    // ---- 4. 截断 ----
    checkAborted()
    if (result.length > MAX_LENGTH) {
      result =
        result.slice(0, MAX_LENGTH) +
        `\n\n... [truncated: response body was ${result.length} chars, showing first ${MAX_LENGTH}]`
    }

    cancel()
    return result
  }) as ToolExecutor,
)

function isHtml(content: string): boolean {
  content = content.trim()
  return (
    (content.startsWith('<!DOCTYPE html>') || content.startsWith('<html')) &&
    content.endsWith('</html>')
  )
}
