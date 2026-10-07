/** UUID 生成工具：封装 crypto.randomUUID()。 */
export function v4(): string {
  return crypto.randomUUID()
}

export { v4 as uuid }
