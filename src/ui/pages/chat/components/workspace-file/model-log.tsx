/**
 * ModelLogModal — 3D 预览的「异常日志」弹窗（工具栏那个带徽标的按钮点开的）。
 *
 * 为什么用共享 `Modal` + `createPortal` 到 body：面板是滑动的浮层（`.side-panel` 有自己的
 * 层叠上下文与 `overflow`），`position: fixed` 的遮罩留在里面会被裁掉 —— 与 `GitEntry`
 * 挂错误弹窗同一手法。
 *
 * 四条口径：
 * 1. **新的在上面**：日志是「刚出的问题最要紧」，倒序渲染；同一条反复出现只累加 `×N`
 *    （贴图是异步结算的，会重复上报同一件事）。
 * 2. **标题在渲染时才翻译**（`t` / `tpl`）：条目里存的是中文 key 与参数，切语言后旧条目
 *    跟着变；`detail` 里的文件名 / 路径 / 库原文一概不翻译。
 * 3. **只读**：弹窗不改任何状态，唯二的动作是「复制」「清空」与「关闭」（复制出来的是纯文本，
 *    能直接贴进 issue / 聊天里）。
 * 4. **空态也要有话说**：模型没问题时这里显示「没有发现异常」，而不是一个空白弹窗。
 */
import { createPortal } from 'react-dom'
import Modal from '@/ui/components/shared/Modal'
import { showToast } from '@/ui/components/shared/Toast'
import { t, tpl } from '@/ui/i18n'
import { copyText } from '@/utils/clipboard'
import { clockOf, countDiagnostics, type DiagnosticEntry } from './model-diagnostics'

interface Props {
  visible: boolean
  entries: readonly DiagnosticEntry[]
  onClose: () => void
  onClear: () => void
}

/**
 * 纯文本报告：头部一行汇总，每条一行「[级别] 时间 标题 ×N」，`detail` 缩进在下一行。
 * 用 `t()` 而不是存好的译文，这样贴出去的文本与当前界面语言一致。
 */
function plainTextOf(entries: readonly DiagnosticEntry[]): string {
  const counts = countDiagnostics(entries)
  const lines = [
    `${t('异常日志')} · ${counts.errors} ${t('错误')} / ${counts.warnings} ${t('警告')}`,
  ]
  for (const entry of entries.slice().reverse()) {
    const title = entry.params ? tpl(entry.title, entry.params) : t(entry.title)
    const repeat = entry.count > 1 ? ` ×${entry.count}` : ''
    const level = entry.level === 'error' ? t('错误') : t('警告')
    lines.push(`[${level}] ${clockOf(entry.time)} ${title}${repeat}`)
    if (entry.detail) lines.push(`    ${entry.detail.replace(/\n/g, '\n    ')}`)
  }
  return lines.join('\n')
}

export default function ModelLogModal({ visible, entries, onClose, onClear }: Props) {
  if (!visible) return null
  const counts = countDiagnostics(entries)
  const onCopy = (): void => {
    void copyText(plainTextOf(entries)).then((ok) =>
      showToast(ok ? t('已复制到剪贴板') : t('复制失败'), 1600),
    )
  }

  return createPortal(
    <Modal
      visible
      title={t('异常日志')}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCopy} disabled={entries.length === 0}>
            {t('复制')}
          </button>
          <button
            type="button"
            className="btn-cancel"
            onClick={onClear}
            disabled={entries.length === 0}>
            {t('清空')}
          </button>
          <button type="button" className="btn-confirm" onClick={onClose}>
            {t('关闭')}
          </button>
        </>
      }>
      <div className="wfp-log">
        {entries.length > 0 && (
          <div className="wfp-log-tally">
            <span className="wfp-log-tally-item is-error">
              {t('错误')} <b>{counts.errors}</b>
            </span>
            <span className="wfp-log-tally-item is-warning">
              {t('警告')} <b>{counts.warnings}</b>
            </span>
          </div>
        )}

        {entries.length === 0 ? (
          <p className="wfp-log-empty">{t('没有发现异常')}</p>
        ) : (
          <ul className="wfp-log-list">
            {/* 倒序：最新的在最上面（`entries` 本身按追加顺序存，插入只要 O(1)） */}
            {entries
              .slice()
              .reverse()
              .map((entry) => (
                <li key={entry.id} className={`wfp-log-item is-${entry.level}`}>
                  <div className="wfp-log-head">
                    <span className="wfp-log-level">
                      {entry.level === 'error' ? t('错误') : t('警告')}
                    </span>
                    <span className="wfp-log-title">
                      {entry.params ? tpl(entry.title, entry.params) : t(entry.title)}
                    </span>
                    {entry.count > 1 && <span className="wfp-log-count">×{entry.count}</span>}
                    <time className="wfp-log-time">{clockOf(entry.time)}</time>
                  </div>
                  {entry.detail && <p className="wfp-log-detail">{entry.detail}</p>}
                </li>
              ))}
          </ul>
        )}
      </div>
    </Modal>,
    document.body,
  )
}
