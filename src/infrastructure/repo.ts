/**
 * 通用 Repository 接口
 *
 * 适用于「全量加载、全量保存」的简单持久化场景（如配置类数据）。
 * 非领域 Repository（领域 Repository 应定义在 domain/ports/ 中，有领域语义的方法名）。
 *
 * @example SimpleRepo<SecurityConfig>
 */
export interface SimpleRepo<T> {
  load(): T
  save(data: T): void
}
