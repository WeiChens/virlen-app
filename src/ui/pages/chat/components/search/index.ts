/**
 * search — 消息检索
 * 对外统一出口：`import SearchDialog from './components/search'`
 */
export { default } from './search-dialog'
export { useMessageSearch } from './use-message-search'
export type {
  SearchScope,
  SearchRoleFilter,
  MessageSearchState,
} from './use-message-search'
