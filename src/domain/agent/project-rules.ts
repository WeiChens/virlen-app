/**
 * project-rules — 「项目规则 / 记忆文件」纯策略：选文件名、校验路径、拼提示词片段。
 * 无 I/O（读取在 `services/project-rules-service.ts`），可单测。
 *
 * 闸门动因：内容逐字进入系统提示词且随每轮重发 —— 既要防路径穿越，也要防超大文件挤爆上下文。
 */

/** 默认规则文件名（相对工作目录） */
export const DEFAULT_PROJECT_RULES_FILE = 'AGENTS.md'

/**
 * 注入内容大小上限（字节）。超限**不注入**而非截断：半截的规则比没有更危险
 * （模型会自信地按残缺约定行事）。64 KB 约合 2 万 token。
 */
export const MAX_PROJECT_RULES_BYTES = 64 * 1024

/**
 * 解析生效的规则文件名。
 *
 * - `undefined` / `null`（老版本存下来的 Agent）→ 默认值 `AGENTS.md`
 * - 显式空串（或纯空白）→ 视为「不注入」
 */
export function resolveProjectRulesFile(
  agent: { projectRulesFile?: string } | null | undefined,
): string {
  const raw = agent?.projectRulesFile
  if (raw === undefined || raw === null) return DEFAULT_PROJECT_RULES_FILE
  return raw.trim()
}

/**
 * 规范化并校验规则文件路径。
 *
 * 允许工作目录内的相对路径（不限于 plain 文件名）；拒绝绝对路径 / 盘符 / `~` / 任意 `..` 段 /
 * 空字节 / 空值 / 超 200 字符。顺带归一化：反斜杠 → `/`，丢弃 `.` 段与重复斜杠。
 *
 * ⚠️ 唯一的路径准入实现：编辑弹窗输入时与读取兜底必须用同一函数，否则「界面能存、运行时读不到」。
 *
 * @returns 规范化后的相对路径；为空或不合法时返回 null
 */
export function normalizeProjectRulesPath(input: string): string | null {
  const raw = (input ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.length > 200) return null
  // 绝对路径 / 家目录 / 盘符
  if (raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:/.test(raw)) return null
  if (raw.includes('\0')) return null

  const segments: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    // 任意上跳段一律拒绝：唯一的越界通道，不做「先拼再判」推断
    if (seg === '..') return null
    segments.push(seg)
  }
  return segments.length > 0 ? segments.join('/') : null
}

/** 路径是否可用（`normalizeProjectRulesPath` 的布尔封装，语义：非空且合法） */
export function isSafeProjectRulesPath(input: string): boolean {
  return normalizeProjectRulesPath(input) !== null
}

/** 把文件内容格式化为系统提示词片段，写清来源与优先级（否则模型会平铺对待互斥要求）。 */
export function buildProjectRulesPrompt(
  fileName: string,
  content: string,
): string {
  return [
    `# Project Rules (${fileName})`,
    '',
    `The content below comes from \`${fileName}\` in the current working directory; it is this project's conventions and historical memory.`,
    'Treat it as a **project-level requirement**; when it conflicts with the general instructions, this file takes precedence (except for an explicit requirement from the user in the current turn).',
    '',
    content.trim(),
  ].join('\n')
}
