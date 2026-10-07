/**
 * search — 搜索分类公共函数（id: search），供 search_files_by_name / search_text_in_files 复用：
 * glob 转换、搜索根目录安全解析、可取消任务（taskId + Rust stop_task）。
 */
import { invoke } from '@tauri-apps/api/core'
import { securityService } from '@/services/security-service'

/**
 * Glob 模式 → 正则：`*` 匹配单层任意字符（不含 `/`）、`**` 匹配任意层级、`?` 匹配单层单个字符、
 * `{a,b}` 备选；其他特殊字符自动转义。
 */
export function globToRegex(pattern: string): string {
  if (!pattern) return '^$'
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      // ** 匹配所有层级
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
      } else {
        const opts = pattern.slice(i + 1, end).split(',')
        re +=
          '(' +
          opts.map((o) => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') +
          ')'
        i = end
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c
    } else {
      re += c
    }
    i++
  }
  return '^' + re + '$'
}

/** 解析搜索根目录（安全校验；path 缺省时用 "."，由 securityService 回退到工作目录）。 */
export async function resolveSearchRoot(
  path: string | undefined,
  sessionId: string,
): Promise<string> {
  return securityService.resolveSafePath(path || '.', 'r', sessionId)
}

/**
 * 创建可取消的搜索任务：生成 taskId，abortSignal 触发时通知 Rust 停止遍历；返回的 stop() 可重复调用（内部吞错）。
 */
export function createSearchTask(
  prefix: string,
  abortSignal: AbortSignal,
): { taskId: string; stop: () => void } {
  const taskId = `${prefix}_${crypto.randomUUID()}`
  const stop = () => {
    invoke('stop_task', { taskId }).catch(() => {})
  }
  abortSignal.addEventListener('abort', stop, { once: true })
  return { taskId, stop }
}
