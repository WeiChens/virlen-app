/**
 * project-rules-service — 读取工作目录下的「项目规则 / 记忆文件」（AGENTS.md 等）
 *
 * 唯一使用点：会话创建时组装系统提示词（`agent-service.assembleAgentPrompt`）。
 * 读取结果只在创建那一刻做一次快照，写进 `session.systemPrompt`，之后不再刷新 ——
 * 与 env prompt 同一语义（会话中途改文件不影响已建会话，避免系统提示词在对话中
 * 悄悄变化导致缓存命中率骤降与行为漂移）。
 *
 * 所有失败一律**静默降级**（返回空串，不抛出、不阻断建会话）：
 *   - 未配置文件名 / 无工作目录 / 路径不安全 → 不注入
 *   - 文件不存在 → 不注入（正常情况，不算错误）
 *   - 超过 `MAX_PROJECT_RULES_BYTES` → 不注入（console.warn + 埋点）
 *   - 二进制、编码无法识别、读取失败 → 不注入（console.warn + 埋点）
 */
import { invoke } from '@tauri-apps/api/core'
import {
  buildProjectRulesPrompt,
  MAX_PROJECT_RULES_BYTES,
  normalizeProjectRulesPath,
} from '@/domain/agent/project-rules'
import { track } from '@/utils/telemetry'

/** Rust `stat_path` 返回的路径元信息 */
interface PathStat {
  exists: boolean
  is_file: boolean
  size: number
}

/** Rust `read_file_with_hash` 返回结构（此处只用 content） */
interface FileReadResult {
  content: string
  byte_size: number
  line_count: number
}

/** 拼接路径：统一成 `/`（Rust 侧两种都认，统一便于日志与埋点） */
function joinPath(dir: string, relPath: string): string {
  return `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/${relPath}`
}

/**
 * 读取并格式化项目规则提示词片段。
 *
 * @param workingDir 会话工作目录（为空时调用方应传入默认工作目录）
 * @param fileName   规则文件名（相对工作目录，已由 resolveProjectRulesFile 解析）
 * @returns 可直接拼进系统提示词的文本；不注入时返回空串
 */
export async function loadProjectRulesPrompt(
  workingDir: string | undefined,
  fileName: string,
): Promise<string> {
  if (!workingDir) return ''
  // 兜底再校验一次：老版本存下来的脏配置（绝对路径 / ..）也可能走到这里
  const name = normalizeProjectRulesPath(fileName)
  if (!name) {
    if ((fileName || '').trim()) {
      console.warn(`[project-rules] 规则文件路径不合法，已忽略：${fileName}`)
      track('agent.project_rules.skip', { reason: 'unsafe_path' })
    }
    return ''
  }

  const fullPath = joinPath(workingDir, name)
  try {
    // 先探测再读取：避免为了判断「文件过大」先把整个文件读进内存
    const stat = await invoke<PathStat | null>('stat_path', { path: fullPath })
    if (!stat?.exists || !stat.is_file) return ''
    if (stat.size > MAX_PROJECT_RULES_BYTES) {
      console.warn(
        `[project-rules] ${fullPath} 体积 ${stat.size} 字节，超过上限 ${MAX_PROJECT_RULES_BYTES}，已跳过注入`,
      )
      track('agent.project_rules.skip', {
        reason: 'too_large',
        size: stat.size,
      })
      return ''
    }

    const result = await invoke<FileReadResult>('read_file_with_hash', {
      path: fullPath,
    })
    const content = result?.content ?? ''
    if (!content.trim()) return ''

    track('agent.project_rules.load', {
      size: stat.size,
      line_count: result.line_count,
    })
    return buildProjectRulesPrompt(name, content)
  } catch (e: any) {
    // 文件是二进制 / 编码无法识别 / 无权限，或非 Tauri 环境（浏览器 dev）
    console.warn(
      `[project-rules] 读取 ${fullPath} 失败，已跳过注入：${e?.message || String(e)}`,
    )
    track('agent.project_rules.skip', {
      reason: 'unreadable',
      message: String(e?.message || e).slice(0, 200),
    })
    return ''
  }
}
