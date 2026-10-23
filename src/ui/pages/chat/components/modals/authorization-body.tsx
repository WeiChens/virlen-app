/**
 * AuthorizationBody — 授权确认的正文：标题 / 副标题 / 风险提示 / 正文（命令或脚本）/ 三个动作。
 *
 * 弹窗（`modals/authorization`）与会话内的行内卡片共用同一份 DOM。
 * ⚠️ class 名归 `authorization.scss`，别改：`.authorization` / `.auth-title`（`risk-*` 配色）/ `.actions`。
 * ⚠️ 三个按钮的 ref 由壳注入：弹窗要靠它们在「暂存 → 拒绝 → 允许执行」之间做键盘导航，
 * 行内卡片不注入（它不接管按键，靠浏览器原生的 Tab / Enter）。
 */
import type { RefObject } from 'react'
import { t } from '@/ui/i18n'

export interface AuthorizationActionRefs {
  shelve?: RefObject<HTMLButtonElement | null>
  cancel?: RefObject<HTMLButtonElement | null>
  confirm?: RefObject<HTMLButtonElement | null>
}

interface Props {
  /** 权限名称（展示） */
  title: string
  /** 副标题：AI 给出的操作说明（命令的 tips） */
  subTitle?: string
  /** 正文：命令文本 / 脚本正文等内容 */
  desc?: string
  /** 实际执行的 shell 命令（仅脚本等「desc 不是命令」时提供，作正文上方的一行说明） */
  command?: string
  /** 风险 / 警告提示（可空） */
  hint?: string
  /** 风险等级（仅用于配色，可空） */
  risk?: string
  onConfirm: () => void
  onCancel: () => void
  /** 不传 = 不给「暂存」入口（会话内卡片不提供：它就安静地躺在会话结尾，随时可答） */
  onShelve?: () => void
  /** 弹窗壳用：键盘处理要按这个容器找最上层遮罩 */
  bodyRef?: RefObject<HTMLDivElement | null>
  actionRefs?: AuthorizationActionRefs
}

export default function AuthorizationBody({
  title,
  subTitle,
  desc,
  command,
  hint,
  risk,
  onConfirm,
  onCancel,
  onShelve,
  bodyRef,
  actionRefs,
}: Props) {
  return (
    <div className="authorization" ref={bodyRef}>
      <div className={`auth-title${risk ? ` risk-${risk}` : ''}`}>{title}</div>
      {subTitle && <p className="auth-subtitle">{subTitle}</p>}
      {hint && <p className="auth-hint">{hint}</p>}
      {(desc || command) && (
        <div className="auth-desc">
          {command && <div className="auth-desc-command">{command}</div>}
          {desc && <code>{desc}</code>}
        </div>
      )}
      <div className="actions">
      {onShelve && (
        <button
          ref={actionRefs?.shelve}
          className="btn-shelve"
          onClick={onShelve}>
          {t('暂存')}
        </button>
      )}
        <button
          ref={actionRefs?.cancel}
          className="btn-cancel"
          onClick={onCancel}>
          {t('拒绝')}
        </button>
        <button
          ref={actionRefs?.confirm}
          className="btn-confirm"
          onClick={onConfirm}>
          {t('允许执行')}
        </button>
      </div>
    </div>
  )
}
