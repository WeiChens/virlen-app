export { providerPort } from './provider'
export { searchProviderRegistry } from './search'
export { buildEditorCommand, spawnEditorCommand, EDITOR_PRESETS } from './editor'
export type {
  EditorCommandParams,
  SpawnResult,
  EditorOpenConfig,
  EditorPreset,
} from './editor'
export type {
  ISearchProvider,
  SearchParams,
  SearchResult,
  SearchResultItem,
  SearchProviderSummary,
  SearchTimeRange,
} from './search/types'
// 源代码管理（图形化 Git）：分组 / 徽标口径的唯一实现（纯函数）
export {
  badgeText,
  baseName,
  changedFileCount,
  dirName,
  displayPath,
  groupChanges,
  isStaged,
  isUnstaged,
  statusLetter,
} from './git'
export type {
  GitBranchInfo,
  GitCaps,
  GitChangeEntry,
  GitCommitResult,
  GitDiffScope,
  GitDiffSides,
  GitEntryKind,
  GitGroups,
  GitHeadInfo,
  GitRepoInfo,
  GitStatusSnapshot,
} from './git'
