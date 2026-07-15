/**
 * SearchProviderPort — 搜索供应商注册中心的抽象接口
 *
 * 遵循 Port/Adapter 模式：
 *   - Port（本接口）：定义「搜索供应商管理」的抽象操作
 *   - Adapter：domain/search/index.ts 中的 SearchProviderRegistry 实现
 *
 * 本接口与 ProviderPort 类似，但职责不同：
 *   - ProviderPort → 管理 LLM 聊天供应商
 *   - SearchProviderPort → 管理搜索引擎供应商
 */
import type { ISearchProvider, SearchProviderSummary } from '../search/types'

export interface SearchProviderPort {
  /** 注册一个搜索供应商 */
  register(id: string, provider: ISearchProvider): Promise<void>

  /** 注销一个搜索供应商 */
  unregister(id: string): Promise<boolean>

  /** 根据 id 获取搜索供应商 */
  get(id: string): Promise<ISearchProvider | undefined>

  /** 获取默认搜索供应商 */
  getDefault(): Promise<ISearchProvider | undefined>

  /** 设置默认搜索供应商 */
  setDefault(id: string): Promise<void>

  /** 列出所有已注册的搜索供应商摘要（用于 UI 下拉选择） */
  list(): Promise<SearchProviderSummary[]>
}
