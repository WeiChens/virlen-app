/**
 * present — 声明**已存在的文件**或**网址**为交付物（右侧面板直接打开，不复制内容）
 *
 * ⚠️ 已原生化：默认引擎走 `native_tools/file/present.rs`，本文件是回退路径；
 * 两侧模型侧文案（content）与 `uiData` 形状必须逐字一致（铁律 1，含 `links[].url` / `links[].name`）——
 * 前端靠 `uiData.type = "present"` 把文件与网址摊到右侧面板（见 `services/present-service.ts`）。
 *
 * 只接受面板能预览的类型（判据 `domain/files/preview.ts`，即 Rust `preview_ext.json` 的
 * TS 镜像）：不可预览的类型只进 `skipped` —— 面板对它只会显示「暂不支持预览 → 在系统程序中
 * 打开」，那不叫交付物，所以宁可报错也不开标签。
 *
 * 网址（`http(s)://…`）单独一条队列（`links`）：在面板里开成**网页标签**，不走文件系统。
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import { extensionOf, previewKindOf } from '@/domain/files/preview'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { formatSize, isTauriFsAvailable } from './common'

/** 一次最多声明几个交付物（文件 + 网址合计）：与 Rust `MAX_DELIVERABLES` 同值 */
const MAX_DELIVERABLES = 10

/** uiData.files 的一项（与 Rust 同形） */
interface PresentedFile {
  path: string
  name: string
  sizeBytes: number
}

/** uiData.links 的一项（与 Rust 同形：`name` = 主机，标签文字用它） */
interface PresentedLink {
  url: string
  name: string
}

interface SkippedPath {
  path: string
  reason: string
}

/**
 * `http(s)://…` 的最小校验（与 Rust `parse_http_link` 逐条对应）：
 * 协议白名单、主机非空、不带凭据。规范化仍在地址栏那一侧（`browser/url.ts`）。
 */
function parseHttpLink(raw: string): { url: string; name: string } | { reason: string } {
  const text = raw.trim()
  const lower = text.toLowerCase()
  const scheme = lower.startsWith('https://')
    ? 'https'
    : lower.startsWith('http://')
      ? 'http'
      : ''
  if (!scheme) return { reason: 'only http(s) URLs can be opened in the side panel' }
  const rest = text.slice(scheme.length + 3)
  const hostEnd = rest.search(/[/?#]/)
  const authority = hostEnd < 0 ? rest : rest.slice(0, hostEnd)
  if (!authority) return { reason: 'URL has no host' }
  if (authority.includes('@')) return { reason: 'URL must not carry credentials (user:pass@)' }
  if (/\s/.test(authority)) return { reason: 'URL contains whitespace' }
  return { url: text, name: authority }
}

/** 路径末段（Windows / POSIX 分隔符都认，与 Rust `file_name_of` 同口径） */
function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

/** `path` / `paths` 合成一份请求列表（`path` 在前，与 Rust `requested_paths` 同口径） */
function requestedPaths(args: Record<string, any>): string[] {
  const list: string[] = []
  if (typeof args.path === 'string') list.push(args.path)
  if (Array.isArray(args.paths)) {
    list.push(...args.paths.filter((p: unknown): p is string => typeof p === 'string'))
  }
  return list.filter((p) => p.trim() !== '')
}

toolRegistry.register(
  'present',
  (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult | string> => {
    if (!isTauriFsAvailable())
      return '[present] Error: not running in a Tauri environment'

    const requested = requestedPaths(args)
    if (requested.length === 0) {
      throw new Error(
        'Error: "path" or "paths" is required — pass the file(s) to present.',
      )
    }

    const files: PresentedFile[] = []
    const links: PresentedLink[] = []
    const skipped: SkippedPath[] = []

    for (const input of requested) {
      if (files.length + links.length >= MAX_DELIVERABLES) {
        skipped.push({
          path: input,
          reason: `at most ${MAX_DELIVERABLES} deliverables per call`,
        })
        continue
      }

      // 网址（带 `://`）不是文件：直接进 `links`，不碰文件系统（与 Rust 同一条分叉）
      if (input.includes('://')) {
        const link = parseHttpLink(input)
        if ('reason' in link) {
          skipped.push({ path: input, reason: link.reason })
        } else if (!links.some((l) => l.url === link.url)) {
          links.push(link)
        }
        continue
      }

      let fullPath: string
      try {
        fullPath = await securityService.resolveSafePath(input, 'r', ctx.sessionId)
      } catch (e: any) {
        // 黑名单 / 无法解析的路径：跳过并说明原因（整个调用不因此失败）
        skipped.push({ path: input, reason: e?.message || String(e) })
        continue
      }
      // 同一个文件只开一个标签（标签 id 就是路径）
      if (files.some((f) => f.path === fullPath)) continue

      try {
        const stat = await tauriFs.stat(fullPath)
        if (stat.isDirectory) {
          skipped.push({
            path: fullPath,
            reason: 'is a directory; present a file instead',
          })
          continue
        }
        // 面板预览不了的类型：开标签只会显示「暂不支持预览 → 在系统程序中打开」，那不是交付物
        //（reason 与 Rust `present.rs` 逐字一致，铁律 1）
        if (previewKindOf(fullPath) === 'other') {
          skipped.push({
            path: fullPath,
            reason: `file type .${extensionOf(fullPath)} cannot be previewed in the side panel; export it to a supported format first`,
          })
          continue
        }
        files.push({
          path: fullPath,
          name: fileNameOf(fullPath),
          sizeBytes: stat.size ?? 0,
        })
      } catch {
        skipped.push({ path: fullPath, reason: 'file does not exist' })
      }
    }

    const skipLines = skipped.map((s) => `- ${s.path} — ${s.reason}`)
    // 全被跳过 → 失败：否则模型会以为「已经给用户了」，用户那边什么都没开
    if (files.length === 0 && links.length === 0) {
      throw new Error(
        `Error: no deliverable was presented; nothing was opened in the side panel.\n${skipLines.join('\n')}`,
      )
    }

    const lines = [
      `Presented ${files.length + links.length} deliverable(s) to the user (opened in the side panel on desktop; contents are not copied):`,
      ...files.map((f) => `- ${f.path} (${formatSize(f.sizeBytes)})`),
      ...links.map((l) => `- ${l.url} (web page, opened in the side panel browser)`),
    ]
    if (skipped.length > 0) {
      lines.push('', `Skipped ${skipped.length} path(s):`, ...skipLines)
    }

    return {
      content: lines.join('\n'),
      uiData: { type: 'present', files, links, skipped },
    }
  }) as ToolExecutor,
  t('交付文件'),
)
