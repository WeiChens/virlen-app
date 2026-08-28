/**
 * editor — 打开编辑器领域类型定义
 */

/** 命令模板参数 */
export interface EditorCommandParams {
  /** 文件绝对路径 */
  filePath: string
  /** 行号（从 1 开始） */
  line?: number
  /** 列号 */
  column?: number
  [key: string]: string | number | undefined
}

/** 命令启动结果 */
export interface SpawnResult {
  ok: boolean
  command?: string
  message?: string
}

/** 打开编辑器配置（可持久化到 localStorage） */
export interface EditorOpenConfig {
  /** 配置唯一 ID */
  id: string
  /** 配置名称，如 VS Code / IntelliJ IDEA */
  name: string
  /** 打开命令模板，支持 ${filePath} ${line} ${column} 占位符，如 code -g "${filePath}:${line}" */
  command: string
  createdAt: number
  updatedAt: number
}

/** 内置编辑器预设（不可修改，仅供快速选用） */
export interface EditorPreset {
  /** 显示名称 */
  name: string
  /** 命令模板，支持 ${filePath} ${line} ${column} 占位符 */
  command: string
  /** 卡片图标路径（public/ide 下的 SVG） */
  iconPath: string
}
