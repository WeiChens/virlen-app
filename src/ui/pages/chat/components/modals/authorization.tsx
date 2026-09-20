/**
 * AuthorizationModal — 通用「授权确认」弹窗
 *
 * 统一承载所有需要用户授权的操作（当前：命令执行 / 脚本执行 / 沙盒脱壳）。
 * 后续新增授权权限时，只需构造 `AuthorizationRequest`（permName/title/subTitle/desc）即可复用，
 * 不必再新增弹窗。
 *
 * 布局约定（与 `AuthorizationRequest` 一一对应）：
 *  - 标题栏：`授权确认` + 权限唯一 key（如 terminal.normal.execute）→ 让用户明确「为哪个权限授权」；
 *  - 正文三段：title（权限名称）/ sub-title（AI 说明）/ desc（命令等内容）；
 *  - hint：风险 / 警告提示（风险提示 + 绕过沙盒警告），有则显示。
 */
import Modal from '@/ui/components/shared/Modal'
import { t } from '@/ui/i18n'
import './authorization.scss'

interface Props {
  visible: boolean
  /** 权限唯一 key（跨 TS / Rust 稳定契约），如 `terminal.normal.execute` */
  permName: string
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
  onShelve: () => void
}

export default function AuthorizationModal({
  visible,
  permName,
  title,
  subTitle,
  desc,
  command,
  hint,
  risk,
  onConfirm,
  onCancel,
  onShelve,
}: Props) {
  return (
    <Modal
      visible={visible}
      onClose={onCancel}
      title={
        <>
          {t('授权确认')}
          {permName && (
            <code className="authorization-perm-key">{permName}</code>
          )}
        </>
      }
      width={`min(1000px, 80vw)`}>
      <div className="authorization">
        <div className={`auth-title${risk ? ` risk-${risk}` : ''}`}>
          {title}
        </div>
        {subTitle && <p className="auth-subtitle">{subTitle}</p>}
        {hint && <p className="auth-hint">{hint}</p>}
        {(desc || command) && (
          <div className="auth-desc">
            {command && <div className="auth-desc-command">{command}</div>}
            {desc && <code>{desc}</code>}
          </div>
        )}
        <div className="actions">
          <button className="btn-shelve" onClick={onShelve}>
            {t('暂存')}
          </button>
          <button className="btn-cancel" onClick={onCancel}>
            {t('拒绝')}
          </button>
          <button className="btn-confirm" onClick={onConfirm}>
            {t('允许执行')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
