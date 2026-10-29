/**
 * MCP 服务器改名 → 迁移白名单里的公开工具名（纯逻辑，无 I/O）。
 *
 * 为什么要迁移：公开名 `mcp__<server>__<raw>` 里的 `<server>` 就是**服务器配置名**
 * （Rust `mcp::naming::public_tool_name`），而 Agent 的 `allowTools` 是**穷举白名单**。
 * 改名不迁移 = 把该服务器的所有工具从每个 Agent 上静默摘掉，界面却还写着「已选 N 个工具」
 * （真实事故：改名后 48 行一个都没勾、计数仍显示 35，见 §11.69）。
 *
 * ⚠️ 迁移边界（宁可留下幽灵名，也不要写一个不存在的名字 —— 那等于卖给模型一个假工具）：
 * - 只替换**纯净前缀** `mcp__<旧名>__`。服务器名两侧都校验过 `^[A-Za-z0-9_-]{1,32}$`，
 *   所以这一步是纯前缀替换，不是「在前端再实现一遍命名生成」（铁律见 `naming.ts`）；
 * - 尾部像指纹（`_[0-9a-f]{12}`）的一律不动：那是 Rust 归一化（非法字符 / 超 64 字符）时
 *   追加的 SHA-256 前缀，指纹里含旧服务器名，反推不出新名；
 * - 拼完超过 64 字符（provider 函数名上限）的不动：Rust 会给它加指纹，我们拼的反而对不上。
 * 这些留下的幽灵名由 Agent 编辑器的「N 项已失效 + 清理」兜底。
 */
import { MCP_PREFIX } from './naming'

/** 服务器名与工具名之间的分隔符（`__`，服务器名校验禁止出现） */
const SEP = '__'

/** provider 函数名上限（与 Rust `MAX_PUBLIC_NAME_LEN` 同值，仅用于「太长就别猜」的判断） */
const MAX_PUBLIC_NAME_LEN = 64

/** 尾部是否像 Rust 归一化时追加的身份指纹 */
const HASH_SUFFIX = /_[0-9a-f]{12}$/

/**
 * 单个公开名的迁移；不该改 / 改不动 → `null`（调用方据此统计「改了几条」）。
 *
 * 改名前后同名也算 `null`：不改就不该被算成一次迁移（否则白名单会被无谓地重写一遍）。
 */
export function migrateToolName(
  name: string,
  oldServer: string,
  newServer: string,
): string | null {
  if (!oldServer || !newServer || oldServer === newServer) return null
  const oldPrefix = `${MCP_PREFIX}${oldServer}${SEP}`
  if (!name.startsWith(oldPrefix)) return null
  const raw = name.slice(oldPrefix.length)
  // 名字残缺 / 带指纹 → 无法可靠重算（见文件头说明）
  if (!raw || HASH_SUFFIX.test(name)) return null
  const next = `${MCP_PREFIX}${newServer}${SEP}${raw}`
  if (next.length > MAX_PUBLIC_NAME_LEN) return null
  return next
}

export interface MigrateResult<T> {
  /** 迁移后的列表；未改动的元素**保持引用相等**，调用方据此只写真正变了的那几个 */
  agents: T[]
  /** 实际改写的名字条数（0 = 什么都没动） */
  changed: number
}

/**
 * 迁移一组 Agent 的白名单。只处理 `allowTools`，其余字段原样传递（引用相等）。
 *
 * 迁移后可能撞名（该 Agent 早就手动勾了新名）→ 保序去重，避免白名单里出现两条一样的。
 */
export function migrateAllowedToolNames<T extends { allowTools: string[] }>(
  agents: readonly T[],
  oldServer: string,
  newServer: string,
): MigrateResult<T> {
  let changed = 0
  const next = agents.map((agent) => {
    if (!agent.allowTools?.some((name) => migrateToolName(name, oldServer, newServer))) {
      return agent
    }
    const seen = new Set<string>()
    const allowTools: string[] = []
    for (const name of agent.allowTools) {
      const migrated = migrateToolName(name, oldServer, newServer)
      if (migrated) changed += 1
      const final = migrated ?? name
      if (seen.has(final)) continue
      seen.add(final)
      allowTools.push(final)
    }
    return { ...agent, allowTools }
  })
  return { agents: changed > 0 ? next : [...agents], changed }
}
