/** editor — 编辑器预设模板（设置页一键选用；图标在 public/ide/，经 /ide/xxx.svg 引用）。 */
import type { EditorPreset } from './types'

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
