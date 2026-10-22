/**
 * DocumentView — `docx` / `doc` / `pptx` / `ppt` 的预览。
 *
 * 正文是 Rust 抽出来的 **Markdown**（标题 / 列表 / 表格都在，见 `doc_parse::office`），
 * 交给聊天区同一套渲染器（`MarkdownRenderer`）—— 面板里不再有一份「文档排版」实现。
 *
 * 三条口径：
 * 1. **图片 / 合并单元格只是说明**：抽取器不画图，也不渲染 span（GFM 没有这个语法），
 *    它在正文里就地标一句 `image 3 · png · 640×480 px`、在表前插一句合并说明 ——
 *    这些英文说明是**给模型的**，界面不翻译、也不显示（这里只渲染正文）；
 * 2. **太长就截断**（Rust 侧按字符数上限切），提示条说清共多少字，并给「系统程序打开」的出口；
 * 3. 面板宽度窄：正文按面板字号（比聊天区小一号），由 `.wfp-preview` 统一控制。
 */
import { useMemo } from 'react'
import { t, tpl } from '@/ui/i18n'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'

interface Props {
  /** Markdown 正文（可能已按上限截断） */
  text: string
  /** 全文的字符数（不是 `text.length`） */
  charCount: number
  truncated: boolean
  onOpenInSystem: () => void
}

export default function DocumentView({ text, charCount, truncated, onOpenInSystem }: Props) {
  // Rust 的 `charCount` 按**字符**数（一个中文 / 一个 emoji 都算 1），`String.length` 是 UTF-16 码元：
  // 星平面字符（emoji）会差 1，所以这里按同样的口径数一次，免得「显示 0 字 / 共 1 字」这种自相矛盾
  const shown = useMemo(() => (truncated ? Array.from(text).length : 0), [text, truncated])

  return (
    <div className="wfp-doc">
      {truncated && (
        <div className="wfp-preview-note">
          <span>
            {tpl('内容过长，仅显示前 $__chars__ 字（共 $__total__ 字）', {
              chars: shown,
              total: charCount,
            })}
          </span>
          <button type="button" className="wfp-action" onClick={onOpenInSystem}>
            {t('在系统程序中打开')}
          </button>
        </div>
      )}
      <div className="wfp-preview">
        <MarkdownRenderer content={text} />
      </div>
    </div>
  )
}
