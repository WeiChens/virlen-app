/**
 * 轨迹检查器「工具」页：本会话发给模型的工具目录（名称 / 界面文案 / 描述 / 参数）。
 *
 * 形态与 dsh 的 ToolCatalog 对齐：每个工具一个折叠项 —— 收起时只占一行（名称 + 一行描述），
 * 展开才渲染完整描述与参数 JSON。37 个工具全部铺开就是几万字符的 JSON，检查器会被刷成一片。
 */
import { t, tpl } from '@/ui/i18n'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import ToolSvg from '@/ui/components/icons/ToolSvg'
import type { ToolCatalogState } from './use-tool-catalog'

export type TrajectoryToolCatalogProps = ToolCatalogState

/** 折叠态那一行描述：压掉换行与多余空白，CSS 再按宽度省略 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function TrajectoryToolCatalog({
  tools,
  loading,
  error,
}: TrajectoryToolCatalogProps) {
  if (loading) {
    return <p className="trajectory-note">{t('正在加载工具定义…')}</p>
  }
  if (error !== null) {
    return (
      <>
        <p className="trajectory-tools__error">{t('读取工具定义失败')}</p>
        <pre className="trajectory-pane">{error}</pre>
      </>
    )
  }
  if (tools.length === 0) {
    return (
      <p className="trajectory-tools__empty">{t('本次会话没有可用的工具')}</p>
    )
  }

  return (
    <div className="trajectory-tools">
      <p className="trajectory-note">
        {tpl('共 $__count__ 个工具', { count: tools.length })} ·{' '}
        {t(
          '来自工具定义权威源，按本会话的白名单过滤 —— 就是随请求发给模型的名称、描述与参数。',
        )}
      </p>
      {tools.map((tool) => {
        const description = oneLine(tool.description)
        return (
          <details className="trajectory-tools__item" key={tool.name}>
            <summary className="trajectory-tools__summary">
              <DropDownSvg className="trajectory-tools__chevron" />
              <ToolSvg className="trajectory-tools__icon" />
              <span className="trajectory-tools__name">{tool.name}</span>
              {tool.label && (
                <span className="trajectory-tools__label">{t(tool.label)}</span>
              )}
              {description !== '' && (
                <span className="trajectory-tools__desc">{description}</span>
              )}
            </summary>
            <div className="trajectory-tools__body">
              {tool.description !== '' && (
                <p className="trajectory-tools__full">{tool.description}</p>
              )}
              <pre className="trajectory-pane is-mono">
                {JSON.stringify(tool.parameters, null, 2)}
              </pre>
            </div>
          </details>
        )
      })}
    </div>
  )
}
