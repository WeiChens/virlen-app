/**
 * search-box —— 侧边栏三个页签共用的搜索框
 *
 * 位置固定在页签（tabs）下方、内容区上方；每个页签各自渲染一个，**只在当前页签可见**。
 * 三个页签的检索语义并不相同（会话 / 技能是本地过滤，工作目录是磁盘递归搜索），
 * 所以关键词状态由各自的页签持有，切页签互不干扰 —— 而不是「一个输入框三个状态」。
 *
 * 样式见 style.scss 的 .sidebar-search（与 .sidebar-tabs 同一套底色 / 圆角）。
 * 输入框内容不进模型上下文，也不落任何存储。
 */
import SearchSvg from '@/ui/components/icons/SearchSvg'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import { t } from '@/ui/i18n'

interface Props {
  value: string
  onChange: (value: string) => void
  /** 占位文案（按页签区分检索目标） */
  placeholder: string
}

export default function SidebarSearch({ value, onChange, placeholder }: Props) {
  return (
    <div className="sidebar-search">
      <SearchSvg className="sidebar-search-icon" />
      <input
        className="sidebar-search-input"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Esc 只清空关键词（有内容时），且不冒泡：
          // 外层（消息检索弹窗 / Modal）的 Esc 关闭语义不该被这里顺带触发
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="sidebar-search-clear"
          onClick={() => onChange('')}
          title={t('清空输入')}
          aria-label={t('清空输入')}
          tabIndex={-1}>
          <CloseSvg />
        </button>
      )}
    </div>
  )
}
