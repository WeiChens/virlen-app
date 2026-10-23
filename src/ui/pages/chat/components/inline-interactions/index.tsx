/**
 * InlineInteractions — 待应答交互的**会话内**通道：卡片挂在会话消息滚动内容的**最底部**。
 *
 * 与弹窗通道（`tool-ui.tsx` 里的 modal 队列）共用同一批应答函数，区别只有三条：
 *  1. 只显示 `sessionId === 当前会话` 的项 —— 切到别的会话就看不到（这就是「不引导立即解决」）；
 *  2. 不接管 document 级键盘：Enter 只在**自定义输入框**里提交，避免在会话里正常打字时误触发；
 *  3. 尺寸按「对话尾巴」设计（12px 级别、一行一个动作），最多展开一张，其余折叠。
 *
 * 为什么没有「暂存」：暂存的语义是「先放下，之后再答」（把 run 存成暂停快照），那是**弹窗打断**时才需要的
 * 退路；卡片本来就安静地躺在会话结尾，随时可答，再给一个「暂存」只会让人误以为要把问题挪走。
 *
 * ⚠️ 切会话时整块卸载，草稿靠 `choice-drafts`（键 = `sessionId|toolCallId`）带回来 ——
 *    别把草稿搬进组件 state（卸载即丢，等于让用户重填一遍）。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { chatState } from '@/ui/store'
import { t, tpl } from '@/ui/i18n'
import MarkdownRenderer from '../message/markdown-renderer'
import InlineAuthBody from './auth-body'
import { useChoiceForm } from '../modals/choice-form'
import { draftKey, getChoiceDraft, saveChoiceDraft } from '../modals/choice-drafts'
import { pendingLabel, type PendingInteraction } from '../modals/pending-interactions'
import type { UserChoiceResult } from '../modals/user-choice'
import './style.scss'

interface Props {
  /** 全部会话的行内待答项（按到达顺序；组件内部只挑当前会话的） */
  items: PendingInteraction[]
  onResolveChoice: (interactionId: string, result: UserChoiceResult) => void
  onCancelChoice: (interactionId: string) => void
  onAllowAuth: (interactionId: string) => void
  onDenyAuth: (interactionId: string) => void
}

/** 卡片头：徽标 + 一行摘要 + 折叠开关（两张卡共用） */
function CardHead({
  tone,
  label,
  summary,
  meta,
  collapsed,
  onToggle,
}: {
  /** 稳定值（不进 i18n）：只用来给徽标上色 */
  tone: 'choice' | 'auth'
  label: string
  /** 省略 = 连权限 key 都没有（只靠占位把右侧元素顶开）；有摘要就必须是能一眼看懂「在问/批什么」的那句 */
  summary?: string
  meta?: string
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <div className="inline-interaction-head">
      <span className={`inline-interaction-badge is-${tone}`}>{label}</span>
      {summary ? (
        <span className="inline-interaction-summary" title={summary}>
          {summary}
        </span>
      ) : (
        // 占位把权限 key / 折叠开关顶到右边（头部是 flex 行，没有可伸缩元素就会挤在左边）
        <span className="inline-interaction-gap" />
      )}
      {meta && <code className="inline-interaction-perm">{meta}</code>}
      <button
        type="button"
        className="inline-interaction-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? t('展开') : t('收起')}
        onClick={onToggle}>
        {collapsed ? '▸' : '▾'}
      </button>
    </div>
  )
}

function ChoiceCard({
  item,
  defaultCollapsed,
  onSubmit,
  onCancel,
}: {
  item: Extract<PendingInteraction, { kind: 'choice' }>
  defaultCollapsed: boolean
  onSubmit: (result: UserChoiceResult) => void
  onCancel: () => void
}) {
  const key = draftKey(item.sessionId, item.toolCallId)
  const form = useChoiceForm({
    options: item.options,
    multi: item.multi,
    // 挂载时取一次草稿（切会话回来 / 暂存恢复都靠它）
    initialDraft: getChoiceDraft(key),
    onDraftChange: (draft) => saveChoiceDraft(key, draft),
  })
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const customInputRef = useRef<HTMLInputElement>(null)

  // 展开自定义输入框时聚焦（与弹窗同手感，但不抢整页焦点）
  useEffect(() => {
    if (form.showCustom) customInputRef.current?.focus()
  }, [form.showCustom])

  // 头部已经把问题压成一行了：只有被截断（或本身多段）时才在正文里补全文，避免同一句话读两遍
  const title = pendingLabel(item)
  const showFullQuestion =
    item.question.includes('\n') || item.question.trim().length > 40

  return (
    <div className="inline-interaction-card is-choice">
      <CardHead
        tone="choice"
        label={t('提问')}
        summary={title}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      />
      {!collapsed && (
        <div
          className="inline-interaction-body"
          onKeyDown={(e) => {
            // 只在自定义输入框里认 Enter（按钮上的 Enter 交给浏览器原生 click）
            const native = e.nativeEvent
            if (native.isComposing || native.keyCode === 229) return
            if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) return
            if ((e.target as HTMLElement).tagName !== 'INPUT') return
            e.preventDefault()
            if (form.canConfirm) onSubmit(form.value)
          }}>
          {showFullQuestion && (
            <div className="inline-interaction-question">
              <MarkdownRenderer content={item.question} />
            </div>
          )}

          <div className="inline-interaction-options">
            {form.options.map((opt) => {
              const on = form.selected.has(opt)
              return (
                <button
                  type="button"
                  key={opt}
                  className={`inline-interaction-option${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => form.toggle(opt)}>
                  <span
                    className={`inline-interaction-mark${form.multi ? ' is-multi' : ''}`}
                    aria-hidden="true">
                    {on ? (form.multi ? '✓' : '●') : ''}
                  </span>
                  <span className="inline-interaction-option-text">{opt}</span>
                </button>
              )
            })}
          </div>

          {form.showCustom && (
            <input
              ref={customInputRef}
              className="inline-interaction-input"
              placeholder={
                form.selected.size > 0 ? t('请输入补充内容') : t('输入自定义回复内容')
              }
              value={form.customReply}
              onChange={(e) => form.setCustomReply(e.target.value)}
            />
          )}

          <div className="inline-interaction-actions">
            <button
              type="button"
              className="inline-interaction-btn is-ghost"
              onClick={() => form.toggleCustom()}>
              {form.showCustom ? t('收起自定义') : t('自定义')}
            </button>
            <button
              type="button"
              className="inline-interaction-btn"
              onClick={onCancel}>
              {t('取消')}
            </button>
            <button
              type="button"
              className="inline-interaction-btn is-primary"
              disabled={!form.canConfirm}
              onClick={() => onSubmit(form.value)}>
              {t('确认')}
              {form.multi
                ? tpl(' (已选 $__count__)', { count: form.selected.size })
                : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AuthCard({
  item,
  defaultCollapsed,
  onAllow,
  onDeny,
}: {
  item: Extract<PendingInteraction, { kind: 'authorization' }>
  defaultCollapsed: boolean
  onAllow: () => void
  onDeny: () => void
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div
      className={`inline-interaction-card is-auth${item.risk === 'dangerous' ? ' is-dangerous' : ''}`}>
      <CardHead
        tone="auth"
        label={t('授权')}
        // 权限名固定归头部：它是这张卡的「在批什么」，展开收起来都不该换位置。
        // 正文（`auth-body.tsx`）因此不再写标题 —— 同一句话读两遍正是改版前的毛病。
        summary={item.title || item.permName}
        meta={item.title ? item.permName : undefined}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      />
      {!collapsed && (
        <div className="inline-interaction-body">
          <InlineAuthBody
            subTitle={item.subTitle}
            desc={item.desc}
            command={item.command}
            hint={item.hint}
            risk={item.risk}
            onConfirm={onAllow}
            onCancel={onDeny}
          />
        </div>
      )}
    </div>
  )
}

function InlineInteractions({
  items,
  onResolveChoice,
  onCancelChoice,
  onAllowAuth,
  onDenyAuth,
}: Props) {
  const sessionId = chatState.value.currentSessionId
  const mine = sessionId ? items.filter((i) => i.sessionId === sessionId) : []
  const rootRef = useRef<HTMLDivElement>(null)
  /** 上一轮看到的项数 / 会话：用来区分「新卡片到了」与「切了会话」 */
  const seenRef = useRef({ sessionId, count: mine.length })

  /**
   * 新卡片到且用户本来就在底部（刚看完最后一条消息）→ 跟过去；在上滑读历史时不打扰。
   * 卡片本身在滚动容器底部，不跟一下的话它正好落在折叠线以下（列表的「贴底」只对齐消息行）。
   */
  useEffect(() => {
    const seen = seenRef.current
    const grew = seen.sessionId === sessionId && mine.length > seen.count
    seenRef.current = { sessionId, count: mine.length }
    if (!grew) return
    const el = rootRef.current?.closest(
      '.chat-messages-container',
    ) as HTMLElement | null
    if (!el) return
    if (el.scrollHeight - el.clientHeight - el.scrollTop > 240) return
    el.scrollTop = el.scrollHeight
  }, [sessionId, mine.length])

  if (mine.length === 0) return null

  return (
    <div
      ref={rootRef}
      className="inline-interactions"
      role="region"
      aria-label={t('待你回答的交互')}>
      {mine.length > 1 && (
        <div className="inline-interactions-count">
          {tpl('$__count__ 个待你回答', { count: mine.length })}
        </div>
      )}
      {mine.map((item, index) =>
        item.kind === 'choice' ? (
          <ChoiceCard
            key={item.interactionId}
            item={item}
            // 第一张展开，其余折叠：不一口气吃掉半个屏幕
            defaultCollapsed={index > 0}
            onSubmit={(result) => onResolveChoice(item.interactionId, result)}
            onCancel={() => onCancelChoice(item.interactionId)}
          />
        ) : (
          <AuthCard
            key={item.interactionId}
            item={item}
            defaultCollapsed={index > 0}
            onAllow={() => onAllowAuth(item.interactionId)}
            onDeny={() => onDenyAuth(item.interactionId)}
          />
        ),
      )}
    </div>
  )
}

export default observer(InlineInteractions)
