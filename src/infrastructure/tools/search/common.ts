/**
 * search — 搜索分类公共函数（分类 id: search）
 *
 * 供 search_files_by_name / search_text_in_files 复用：
 * glob 转换、搜索根目录安全解析、可取消任务（taskId + Rust 端 stop_task）。
 */
import { invoke } from '@tauri-apps/api/core'
import { securityService } from '@/services/security-service'

/**
 * 将 Glob 模式转换为正则表达式
 *
 * 支持的语法：
 *   - `*`   匹配单层路径中的任意字符（不含 `/`）
 *   - `**`  匹配任意层级路径
 *   - `?`   匹配单层路径中的单个字符（不含 `/`）
 *   - `{a,b}` 备选模式（匹配 a 或 b）
 *   其他特殊字符自动转义
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

/**
 * 解析搜索根目录（安全校验；path 缺省时用 "."，由 securityService 回退到工作目录）
 */
export async function resolveSearchRoot(
  path: string | undefined,
  sessionId: string,
): Promise<string> {
  return securityService.resolveSafePath(path || '.', 'r', sessionId)
}

/**
 * 创建可取消的搜索任务
 *
 * 生成 taskId 并在 abortSignal 触发时通知 Rust 端停止遍历。
 * 返回的 stop() 可重复调用（内部吞掉错误），供 invoke 回退分支与取消分支复用。
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
