/**
 * editor-presets — 打开编辑器预设模板
 *
 * 用户在设置页可一键选用这些常用编辑器的命令模板，
 * 也可选择「自定义」手动输入任意命令。
 * 图标文件位于 public/ide/，通过 /ide/xxx.svg 引用。
 */

export interface EditorPreset {
  /** 显示名称 */
  name: string
  /** 命令模板，支持 ${filePath} ${line} ${column} 占位符 */
  command: string
  /** 卡片图标路径（public/ide 下的 SVG） */
  iconPath: string
}

export const EDITOR_PRESETS: EditorPreset[] = [
  {
    name: 'VS Code',
    command: 'code -g "${filePath}:${line}"',
    iconPath: '/ide/vscode.svg',
  },
  {
    name: 'Cursor',
    command: 'cursor -g "${filePath}:${line}"',
    iconPath: '/ide/cursor.svg',
  },
  {
    name: 'Visual Studio',
    command: 'devenv /Command "Edit.GoTo ${line}" "${filePath}"',
    iconPath: '/ide/visual-studio.svg',
  },
  {
    name: 'IntelliJ IDEA',
    command: 'idea --line ${line} "${filePath}"',
    iconPath: '/ide/idea.svg',
  },
  {
    name: 'PyCharm',
    command: 'pycharm --line ${line} "${filePath}"',
    iconPath: '/ide/pycharm.svg',
  },
  {
    name: 'Sublime Text',
    command: 'subl "${filePath}:${line}"',
    iconPath: '/ide/sublime_text.svg',
  },
]
