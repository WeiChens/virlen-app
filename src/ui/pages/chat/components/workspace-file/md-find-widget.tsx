/**
 * 文件 markdown 预览的查找浮层（Ctrl/Cmd+F），锚在预览区右上角 —— 布局与交互对齐 Monaco 的查找框：
 * 输入框 + `3/12` 计数 + 区分大小写 + 上一个/下一个 + 关闭。
 *
 * 只负责「长什么样 / 按了什么」，匹配和跳转都在 VirtualMarkdown（`md-find.ts` 出数据）。
 * 三个手感细节：
 * - 打开即聚焦并**全选**旧查询（再按 Ctrl+F 就是改词，不用先删）；
 * - 按钮 `onMouseDown` 阻止默认：点上一个/下一个时焦点留在输入框，可以接着按 Enter；
 * - Enter 下一个 / Shift+Enter 上一个 / Escape 关闭，与 Monaco 一致。
 */
import { useEffect, useRef } from 'react'
import { t } from '@/ui/i18n'
import SearchSvg from '@/ui/components/icons/SearchSvg'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import { FIND_INPUT_ATTR } from './md-find'

interface Props {
  query: string
  /** 全量命中数（源码级，不只是已渲染的块） */
  total: number
  /** 当前命中下标（0 基）；没有命中时为 -1 */
  current: number
  caseSensitive: boolean
  /**
   * 「重新聚焦并全选」信号：每次 `Ctrl+F` 自增一次。
   * 用信号而不是在父层直接操作 DOM：父层可能要先把选中文本写进查询，
   * 输入框得先拿到新值再全选（否则 select() 选的是上一轮的文本）。
   */
  focusSignal: number
  onQueryChange: (query: string) => void
  onCaseToggle: () => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export default function MdFindWidget({
  query,
  total,
  current,
  caseSensitive,
  focusSignal,
  onQueryChange,
  onCaseToggle,
  onPrev,
  onNext,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  // 刚打开 / 每次按 Ctrl+F：聚焦并全选（再按一次就是改词，而不是在末尾接着输）
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  const empty = total === 0

  return (
    <div className="wfp-find" role="search" aria-label={t('在文档中查找')}>
      <SearchSvg className="wfp-find-icon" />
      <input
        {...{ [FIND_INPUT_ATTR]: 'true' }}
        ref={inputRef}
        className="wfp-find-input"
        value={query}
        placeholder={t('在文档中查找')}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('在文档中查找')}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrev()
            else onNext()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            // 别让 Escape 继续冒泡：外壳还可能有「关面板」之类的快捷键
            event.stopPropagation()
            onClose()
          }
        }}
      />
      <span className={`wfp-find-count${empty && query !== '' ? ' is-empty' : ''}`}>
        {query === '' ? '' : empty ? t('无结果') : `${current + 1}/${total}`}
      </span>
      <button
        type="button"
        className={`wfp-find-btn wfp-find-case${caseSensitive ? ' is-on' : ''}`}
        title={t('区分大小写')}
        aria-label={t('区分大小写')}
        aria-pressed={caseSensitive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onCaseToggle}>
        Aa
      </button>
      <span className="wfp-find-sep" />
      <button
        type="button"
        className="wfp-find-btn"
        title={t('上一个')}
        aria-label={t('上一个')}
        disabled={empty}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPrev}>
        <CollapsedSvg className="is-up" />
      </button>
      <button
        type="button"
        className="wfp-find-btn"
        title={t('下一个')}
        aria-label={t('下一个')}
        disabled={empty}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onNext}>
        <CollapsedSvg />
      </button>
      <button
        type="button"
        className="wfp-find-btn"
        title={t('关闭查找')}
        aria-label={t('关闭查找')}
        onClick={onClose}>
        <CloseSvg />
      </button>
    </div>
  )
}
