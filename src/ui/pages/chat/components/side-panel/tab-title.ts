/**
 * 标签的**显示名**（标签栏、tooltip、开始页「其他对话的标签页」清单共用这一份）。
 *
 * 为什么单独一个文件：容器与开始页都要它，写两遍必然分叉 —— 同一个终端在一处叫
 * 「PowerShell 7」、另一处叫 `terminal:3`，用户会以为不是同一个东西。
 * 也没放进 `tabs.ts`：那个文件是纯模型（不碰 React），而终端名要从 `terminal/shells.tsx` 取。
 *
 * 口径（与标签栏一致，**顺序即优先级**）：
 * - 文件 → 文件名（不是全路径，长路径会把标签撑爆）；
 * - 终端 → shell 类型名（同名无所谓，靠 tooltip 里的工作目录区分，不编「终端 1 / 2」）；
 * - 网页 → 页面标题 → 主机名 → 「浏览器」（还没导航过的空白页）；
 * - 服务 → 服务名 → 服务 id（列表还没轮询回来时也要有个标题）。
 */
import { t } from '@/ui/i18n'
import { shellLabel } from '../terminal/shells'
import { urlLabel } from './browser/url'
import { tabLabel, type SidePanelTab } from './tabs'

export function tabDisplayName(tab: SidePanelTab): string {
  switch (tab.kind) {
    case 'file':
      return tabLabel(tab.path)
    case 'guide':
      return t('开始页')
    case 'files':
      return t('工作区文件')
    case 'terminal':
      return shellLabel(tab.shell)
    case 'browser':
      return tab.title || urlLabel(tab.url) || t('浏览器')
    case 'service':
      return tab.name || tab.serviceId
  }
}
