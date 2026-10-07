/**
 * SearchProviderPort — 搜索供应商注册中心端口（Adapter 为 domain/search 的 SearchProviderRegistry）。
 * 与 ProviderPort 平行：后者管 LLM 供应商，本接口管搜索引擎供应商。
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
