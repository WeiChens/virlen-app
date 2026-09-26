/**
 * get_current_time — 获取当前时间（支持 IANA 时区参数）
 *
 * 模型侧**固定英文**（与 Rust 原生实现 / CLI 一致，铁律 1）；UI 侧只下发「时间戳 + 时区」这个语言无关
 * 结构，由组件按当前 UI 语言本地化 —— 因此同一个工具在「Rust 引擎 / TS 引擎」×「中 / 英文界面」四种
 * 组合下都不会分叉。
 *
 * ⚠️ Rust 侧原生实现已就位（`native_tools/system/get_current_time.rs`，`chrono-tz`）；本文件是回退路径，
 * 必须保持同结果：格式、默认时区、非法时区文案一律逐字对齐。
 */
import { toolRegistry } from '@/domain/tools'
import {
  ToolError,
  type ToolContext,
  type ToolExecutor,
  type ToolResult,
} from '@/domain/tools/types'
import { t } from '@/ui/i18n'

toolRegistry.register(
    'get_current_time',
    (async (args: Record<string, any>, _ctx: ToolContext): Promise<ToolResult> => {
    const timezone = (args.timezone as string) || 'Asia/Shanghai'
    const now = new Date()
    // 时区预校验：非法时 `Intl` 会抛 `RangeError`，而它的措辞随引擎/ICU 版本变化 ——
    // 这里换成与 Rust 侧（`chrono_tz::Tz::from_str` 失败）**同一文案**，避免两侧分叉（铁律 1）。
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now)
    } catch {
      throw new ToolError(`Invalid time zone: "${timezone}"`, {
        timezone,
        errorKind: 'invalid_timezone',
      })
    }
    return {
      content: now.toLocaleString('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long',
      }),
      uiData: { timestamp: now.getTime(), timezone },
    }
  }) as ToolExecutor,
    t('获取当前时间'),
)
