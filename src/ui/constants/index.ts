/**
 * 全局常量定义
 *
 * 合并自旧目录 config/ + const/
 *   - config/index.ts        → 应用基础信息
 *   - const/index.ts          → 业务常量
 *   - config/quickActions.ts  → 快捷操作数据（独立文件）
 */

// ==================== 应用基础信息（原 config/index.ts）====================

export const appName = 'Virlen'
export const appLogo = '/logo.png'
import AppLogoSvg from '@/ui/components/icons/AppLogoSvg'
export { AppLogoSvg }

/** API 基础地址 */
export const domain = import.meta.env.VITE_API_BASE_URL || ''

// ==================== 业务常量（原 const/index.ts）====================

/** 默认 Agent 的固定 ID */
export const DEFAULT_AGENT_ID = '__default__'
