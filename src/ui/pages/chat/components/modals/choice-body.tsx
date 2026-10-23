/**
 * ChoiceBody — `user_choice` 的正文：选项列表 + 自定义输入 + 底部动作。
 *
 * 弹窗（`modals/user-choice`）与会话内的行内卡片共用同一份 DOM。
 * ⚠️ 结构与 class 名不要改：`user-choice.scss` 的配色、`.choice-option` 上的 `data-nav|data-index`
 *（弹窗的 Tab / 方向键导航靠它）以及既有用例都按这套取值。
 */
import { useRef } from 'react'
import { t, tpl } from '@/ui/i18n'
import type { ChoiceForm } from './choice-form'

interface Props {
  form: ChoiceForm
  onConfirm: () => void
  onCancel: () => void
  /** 不传 = 不给「暂存」入口（暂存会暂停整个 run，行内卡片与弹窗同口径，默认都给） */
  onShelve?: () => void
}

export default function ChoiceBody({ form, onConfirm, onCancel, onShelve }: Props) {
  const customInputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <div className="choice-body">
        <div className="choice-options">
          {form.options.map((opt, index) => {
            const isSelected = form.selected.has(opt)
            return (
              <div
                key={opt}
                className={`choice-option ${isSelected ? 'selected' : ''}`}
                data-nav="option"
                data-index={index}
                tabIndex={0}
                role="checkbox"
                aria-checked={isSelected}
                onClick={() => form.toggle(opt)}>
                <span className="choice-checkbox">
                  {form.multi ? (
                    <span className={`check-box ${isSelected ? 'checked' : ''}`}>
                      {isSelected ? '✓' : ''}
                    </span>
                  ) : (
                    <span className={`radio-box ${isSelected ? 'checked' : ''}`}>
                      {isSelected ? '●' : ''}
                    </span>
                  )}
                </span>
                <span className="choice-label">{opt}</span>
              </div>
            )
          })}
        </div>

        {/* 自定义回复输入框 —— 默认隐藏，点「自定义」后显示 */}
        {form.showCustom && (
          <div className="choice-custom-reply">
            <input
              ref={customInputRef}
              className="custom-reply-input"
              data-nav="input"
              placeholder={
                form.selected.size > 0
                  ? t('请输入补充内容')
                  : t('输入自定义回复内容')
              }
              value={form.customReply}
              onChange={(e) => form.setCustomReply(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="choice-footer">
        <div className="choice-footer-left">
          {onShelve && (
            <button className="btn-shelve" data-nav="button" onClick={onShelve}>
              {t('暂存')}
            </button>
          )}
          <button
            className="btn-custom"
            data-nav="button"
            onClick={() => {
              form.toggleCustom()
              // 展开时自动聚焦输入框
              setTimeout(() => customInputRef.current?.focus(), 0)
            }}>
            {form.showCustom ? t('收起自定义') : t('自定义')}
          </button>
        </div>
        <div className="choice-footer-right">
          <button className="btn-cancel" data-nav="button" onClick={onCancel}>
            {t('取消')}
          </button>
          <button
            className="btn-confirm"
            data-nav="button"
            onClick={onConfirm}
            disabled={!form.canConfirm}>
            {t('确认')}
            {form.multi
              ? tpl(' (已选 $__count__)', { count: form.selected.size })
              : ''}
          </button>
        </div>
      </div>
    </>
  )
}
