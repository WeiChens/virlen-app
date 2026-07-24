/**
 * Skill 系统 — 统一对外 API
 */
export type { SkillMeta, RegisteredSkill, SkillFileEntry } from './types'
export { normalizeSkillName } from './types'
export {
  skillStore,
  readSkillMd,
  scanAndRegisterSkills,
  registerSkill,
  deleteSkill,
  unregisterSkill,
  getRegisteredSkill,
  listRegisteredSkills,
  refreshSkillsMeta,
  getSkillFileTree,
  getSkillsDirPath,
} from './skillStore'
export { importSkillFromZipDialog, importSkillFromZip } from './importService'
export {
  fetchPlazaSkills,
  fetchPlazaCategories,
  fetchPlazaSkillDetail,
  fetchPlazaSkillReadme,
  reportPlazaDownload,
  importSkillFromPlaza,
  isSkillInstalled,
} from './plazaService'
export type {
  RemoteSkill,
  RemoteCategory,
  PaginatedData as PlazaPaginatedData,
  RemoteSkillDetail,
} from './plazaService'
