/**
 * 通用 Repository 接口 —— 适用于「全量加载、全量保存」的简单持久化（如配置类数据）。
 * 非领域 Repository（后者定义在 domain/ports/，有领域语义方法名）。
 */
export interface SimpleRepo<T> {
  load(): T
  save(data: T): void
}
