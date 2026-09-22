/**
 * SkillChip — 技能引用标签 / 卡片（输入框、消息气泡共用）
 *
 * 与 FileChip 刻意不同：文件附件只承载「路径」（内容交给模型用工具按需读），
 * 技能引用承载的是 **SKILL.md 全文**（发送时整份交给模型，见 types 的 SkillContent）。
 *
 * 两种形态：
 *   - chip（输入框）：[拼图图标] 技能名 字符数 [×] —— 单行窄标签，不挤占输入区
 *   - card（消息气泡）：header 与 chip 同款，下面接 SKILL.md frontmatter 的 description
 *     （最多三行），让用户一眼看清「引用的这个技能是干什么的」
 *
 * - hover 显示技能目录绝对路径（内容本体太长，不适合塞进 title）
 * - 传入 onClick 时主体可点击（气泡里用于打开技能目录）；传入 onRemove 时显示移除按钮
 */
import type { MouseEvent } from 'react'
import SkillSvg from '@/ui/components/icons/SkillSvg'
import { t, tpl } from '@/ui/i18n'
import './style.scss'

interface Props {
  /** 技能唯一标识（skillStore 的 meta.name） */
  name: string
  /** 技能源码目录绝对路径 */
  path?: string
  /** SKILL.md 字符数（发送体积的量级提示） */
  chars?: number
  /** 技能描述（SKILL.md frontmatter 的 description），仅卡片形态渲染 */
  description?: string
  /** 形态：chip = 单行窄标签（输入框）；card = 长方形卡片（消息气泡） */
  variant?: 'chip' | 'card'
  /** 点击主体（打开技能目录） */
  onClick?: () => void
  /** 右键（气泡里用于弹「打开 / 复制路径」菜单） */
  onContextMenu?: (ev: MouseEvent<HTMLSpanElement>) => void
  /** 移除该技能引用 */
  onRemove?: () => void
  className?: string
}

function SkillChip({
  name,
  path,
  chars,
  description,
  variant = 'chip',
  onClick,
  onContextMenu,
  onRemove,
  className,
}: Props) {
  const isCard = variant === 'card'
  // 全文在 title 里放不下：标题只交代「这是什么 + 从哪来」
  // 卡片里描述会被裁到三行，完整描述一并放进 title，悬停还能看全
  const title = [
    tpl('引用技能：$__name__', { name }),
    isCard ? description || '' : '',
    t('发送时会附带整份 SKILL.md'),
    path || '',
  ]
    .filter(Boolean)
    .join('\n')

  // header：图标 + 技能名 + 字符数，chip / card 两种形态共用同一套
  const header = (
    <>
      <span className="skill-chip-icon">
        <SkillSvg />
      </span>
      <span className="skill-chip-name">{name}</span>
      {typeof chars === 'number' && chars > 0 && (
        <span className="skill-chip-meta">
          {tpl('$__count__ 字符', { count: chars })}
        </span>
      )}
    </>
  )

  const removeNode = onRemove && (
    <button
      type="button"
      className="skill-chip-remove"
      onClick={onRemove}
      title={t('移除技能')}
      aria-label={tpl('移除技能：$__name__', { name })}>
      ✕
    </button>
  )

  /** 卡片正文：header 一行 + 可选描述（描述缺省时不留空行、不画分隔线） */
  const cardContent = (
    <>
      <span className="skill-chip-head">{header}</span>
      {description && <span className="skill-chip-desc">{description}</span>}
    </>
  )

  /**
   * 可点主体
   *
   * card 形态把**整张卡片**（含描述）做成同一个按钮：描述区也是「打开技能目录」的热区，
   * 否则用户在描述上点一下会没反应；键盘焦点也才落在整卡上，而不是只有 header 可聚焦。
   */
  const bodyNode = onClick ? (
    <button
      type="button"
      className="skill-chip-body"
      onClick={onClick}
      aria-label={tpl('打开技能目录：$__path__', { path: path || name })}>
      {isCard ? cardContent : header}
    </button>
  ) : (
    <span className="skill-chip-body">{isCard ? cardContent : header}</span>
  )

  return (
    <span
      className={`skill-chip${isCard ? ' is-card' : ''}${
        isCard && description ? ' has-desc' : ''
      }${className ? ` ${className}` : ''}`}
      title={title}
      onContextMenu={onContextMenu}>
      {bodyNode}
      {removeNode}
    </span>
  )
}

export default SkillChip
