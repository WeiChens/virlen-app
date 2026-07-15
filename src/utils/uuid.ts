/**
 * UUID 生成工具（从 agent/uuid.ts 迁移）
 *
 * 封装 crypto.randomUUID()，提供降级和长度参数
 */
export function v4(): string {
  return crypto.randomUUID()
}

export { v4 as uuid }
