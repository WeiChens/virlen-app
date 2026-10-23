/**
 * InlineAuthBody — 会话内授权卡片的正文（**只服务行内**，不共用弹窗的 `AuthorizationBody`）。
 *
 * 为什么不共用：弹窗是「整屏一次确认」，正文按阅读节奏铺开（15px 大标题 / 引文式说明块 /
 * 120px 起跳的内容框 / 满宽按钮）；卡片是「对话尾巴」，整张卡都在 12px 级。把弹窗那份 DOM
 * 缩一档，层级仍是弹窗的 —— 标题最大，而「到底要执行什么」反倒被压成一段 `<code>`。
 * 这里的排法是「说明 → 警示 → 待执行内容 → 动作」，权限名不进正文：它已经是卡片头的标题。
 *
 * 待执行内容用 `CodePreview`（Monaco 只读预览）：等宽、换行与缩进原样保留，是「逐字看清要执行
 * 什么」最直接的样子；高度按内容算，超上限交给 Monaco 内置滚动条，卡片不撑掉半屏。
 */
import { t } from '@/ui/i18n'
import CodePreview from '@/ui/components/code-preview/CodePreview'
import { useCodeDisplay } from '@/ui/hooks/useCodeDisplay'
import { codePreviewHeight } from '@/domain/code-display'

/** 代码区高度上限（px）：再高就把对话挤走了，超出的部分由 Monaco 内置滚动条承担 */
const CODE_MAX_HEIGHT = 200

interface Props {
  /** AI 给出的操作说明（命令的 tips） */
  subTitle?: string
  /** 待执行内容：命令文本 / 脚本正文 */
  desc?: string
  /** 实际执行的 shell 命令（脚本类才有：要审的是脚本正文，不是这行运行命令） */
  command?: string
  /** 风险 / 脱壳提示（可能多段，后端用 `\n` 续接） */
  hint?: string
  /** 风险等级（只用于配色） */
  risk?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function InlineAuthBody({
  subTitle,
  desc,
  command,
  hint,
  risk,
  onConfirm,
  onCancel,
}: Props) {
  const display = useCodeDisplay()
  const code = desc ?? ''
  const dangerous = risk === 'dangerous'

  return (
    <div className="inline-auth">
      {subTitle && <p className="inline-auth-note">{subTitle}</p>}
      {hint && (
        <p className={`inline-auth-hint${dangerous ? ' is-dangerous' : ''}`}>
          <span className="inline-auth-hint-icon" aria-hidden="true">
            ⚠
          </span>
          <span>{hint}</span>
        </p>
      )}
      {code && (
        <div className="inline-auth-code">
          {command && (
            <div className="inline-auth-code-head">
              <span className="inline-auth-code-label">{t('运行')}</span>
              <code className="inline-auth-code-cmd" title={command}>
                {command}
              </code>
            </div>
          )}
          <CodePreview
            code={code}
            height={codePreviewHeight(code.split('\n').length, display.lineHeightPx)}
            maxContentHeight={CODE_MAX_HEIGHT}
            showLineNumbers={false}
          />
        </div>
      )}
      <div className="inline-interaction-actions is-end">
        <button
          type="button"
          className="inline-interaction-btn btn-cancel"
          onClick={onCancel}>
          {t('拒绝')}
        </button>
        <button
          type="button"
          className="inline-interaction-btn is-primary btn-confirm"
          onClick={onConfirm}>
          {t('允许执行')}
        </button>
      </div>
    </div>
  )
}
