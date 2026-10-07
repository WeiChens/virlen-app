/** 全局常量定义（合并自旧 config/ + const/）。 */

// 应用基础信息

export const appName = 'Virlen'
export const appLogo = '/logo.png'
import AppLogoSvg from '@/ui/components/icons/AppLogoSvg'
export { AppLogoSvg }

/** API 基础地址 */
export const domain = import.meta.env.VITE_API_BASE_URL || 'https://virlen.cn'

// 业务常量

/** 默认 Agent 的固定 ID */
export const DEFAULT_AGENT_ID = '__default__'
