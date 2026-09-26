/**
 * project-rules — 「项目规则 / 记忆文件」的纯策略
 *
 * 只回答三个问题：用哪个文件名、这个路径能不能读、读出来怎么塞进提示词。
 * **不做任何 I/O**（读取在 `services/project-rules-service.ts`），保证可单测。
 *
 * 为什么要有这道闸：规则文件的内容会**逐字**进入系统提示词，并随每一轮请求重发，
 * 因此既要防「读了不该读的文件」（路径穿越），也要防「读了太大的文件」（挤爆上下文）。
 */

/** 默认规则文件名（相对工作目录） */
export const DEFAULT_PROJECT_RULES_FILE = 'AGENTS.md'

/**
 * 注入内容的大小上限（字节）。
 *
 * 64 KB 已约合 2 万 token —— 接近多数模型单轮预算的可用余量，再大只会挤掉对话本身。
 * 超限一律**不注入**而非截断：半截的项目规则比没有更危险（模型会自信地按残缺约定行事）。
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
 * 允许：工作目录内的相对路径（`AGENTS.md`、`.cursor/rules.md`、`.\docs\MEMORY.md`）；拒绝：绝对路径 /
 * 盘符 / `~` / 任意 `..` 段 / 含空字节 / 空值 / 超 200 字符。顺带归一化：反斜杠 → `/`，丢弃 `.` 段与
 * 重复斜杠（因此 `./AGENTS.md` 可用）。
 *
 * ⚠️ 这是唯一的路径准入实现：编辑弹窗在用户输入时用它驳回，读取时再用它兜底（老版本存下的脏配置）——
 * 两边必须是同一个函数，否则「界面上能存、运行时读不到」。
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
    // 任意上跳段一律拒绝 —— 这是唯一的越界通道，不做「先拼再判」的等价性推断
    if (seg === '..') return null
    segments.push(seg)
  }
  return segments.length > 0 ? segments.join('/') : null
}

/** 路径是否可用（`normalizeProjectRulesPath` 的布尔封装，语义：非空且合法） */
export function isSafeProjectRulesPath(input: string): boolean {
  return normalizeProjectRulesPath(input) !== null
}

/**
 * 把文件内容格式化为系统提示词片段。
 *
 * 明确写清「来源」与「优先级」：模型对项目约定与通用说明冲突时的取舍，
 * 全靠这段文字（没有它，模型会平铺对待两段互斥的要求）。
 */
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
