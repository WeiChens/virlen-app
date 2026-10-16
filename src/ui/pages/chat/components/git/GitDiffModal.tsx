/**
 * GitDiffModal — 变更文件的左右对比（模态）：**左侧是全部更改文件的清单，右侧是当前文件的差异**。
 *
 * 四条界面口径（P1.3 / P1.4 实测反馈）：
 * 1. **路径只出现一次** —— 弹窗头已经写了它，`SideBySideDiff` 的文件头不再画（`showHeader={false}`），
 *    顺带去掉它内置的「全屏」按钮：弹窗本身就是放大形态，再套一层全屏没有意义；
 * 2. **暂存 / 取消暂存就在弹窗里** —— 看完差异顺手处理是最常见的下一步，逼用户关掉弹窗回列表再点一次不合理。
 *    操作成功后视图自动翻到另一侧（暂存 → 看 index↔HEAD，取消暂存 → 看工作区↔index），因为
 *    原来那一侧的差异此刻已经空了；
 * 3. **左侧清单随时切换**（↑↓ 键也行）—— 连着看几个文件的差异不必反复开关弹窗。
 *    清单里的一行与面板的行同一套排布：**图标在左、状态字母在右**（两处列的是同一份清单）；
 * 4. **空的那一侧整栏不画**（实测反馈：被删除的文件不必再显示「新文件」）—— 判定按**内容**
 *    （`domain/git::singleSideOf`）：删除只有旧侧、新增 / 未跟踪只有新侧、未合并取不到的那侧为空。
 *    留半栏空白既占宽度，又让人以为「另一侧是空的」是内容问题；
 * 5. **整文件、不省略**（实测反馈：不要用 … 省略相同的部分）：差异行由 `gitDiffRows` 从两侧全文
 *    直接算出来，改动行前后的未改动行照常显示（改了多少字由行内字符级片段标出）。
 *
 * ⚠️ 内容**不缓存**：关掉即弃。缓存正文会让「切了分支却还在显示旧内容」这种问题悄悄出现。
 * ⚠️ 弹窗内的 mousedown 必须 `stopPropagation`（`.git-diff-modal` 上那一行）：入口的「点浮层外关闭」
 * 按 DOM 包含关系判定，而本弹窗是 portal 到 body 的 —— 不拦住就会「点一下弹窗，连面板一起关掉」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, tpl } from '@/ui/i18n'
import {
  baseName,
  dirName,
  displayPath,
  gitDiffRows,
  singleSideOf,
  statusLetter,
} from '@/domain/git'
import type { GitDiffSides } from '@/domain/git'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import { SideBySideDiff } from '../message/SideBySideDiff'
import { loadDiffSides, stage, unstage } from '@/services/git-service'
import type { GitRowTarget } from './GitChangeRow'
import { rowKey, type GitChangeSection } from './sections'
import './style.scss'

interface Props {
  /** 打开时定位到的那一行（列表双击 / 右键「查看差异」） */
  target: GitRowTarget
  /** 左侧清单：与面板**同一个分段视图模型**（这里只渲染，不再复制一份口径） */
  sections: GitChangeSection[]
  /** 只读沙盒 / 有操作在跑：写入口禁用（Rust 侧同样会拒，这里是体验层） */
  disabled: boolean
  onClose: () => void
}

export function GitDiffModal({ target, sections, disabled, onClose }: Props) {
  /** 当前展示的文件 + 它属于哪一侧（侧决定差异基准：更改 = 工作区↔index，已暂存 = index↔HEAD） */
  const [current, setCurrent] = useState<GitRowTarget>(target)
  const [sides, setSides] = useState<GitDiffSides | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)

  const { entry, side } = current
  const scope = side === 'staged' ? 'index' : 'worktree'
  const staged = side === 'staged'
  const actionLabel = staged ? t('取消暂存') : t('暂存更改')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    loadDiffSides(entry.path, scope, entry.orig_path)
      .then((data) => {
        if (alive) setSides(data)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // entry.path 变化 = 换了一个文件；同一路径但基准变了（刚暂存 / 刚取消暂存）也要重取
  }, [entry.path, entry.orig_path, scope])

  /** 左侧清单的扁平顺序（↑↓ 按它走），与面板列表同一顺序 */
  const flat = sections.flatMap((section) =>
    section.entries.map((row) => ({ entry: row, side: section.side })),
  )

  /**
   * 换到清单里的上一个 / 下一个文件；当前文件已不在清单里（刚被处理掉）则落到第一个。
   * 用**函数式更新**：连续按键（长按自动重复）可能在同一帧里来好几下，读写 outer 变量会按同一个
   * 旧值算几遍、看起来「按键失灵」。
   */
  function step(delta: number): void {
    setCurrent((prev) => {
      const at = flat.findIndex(
        (row) => row.entry.path === prev.entry.path && row.side === prev.side,
      )
      return flat[at < 0 ? 0 : at + delta] ?? prev
    })
  }
  /** 键盘监听只挂一次，闭包里的 `flat` 每帧都在变 —— 用 ref 取最新的一份 */
  const stepRef = useRef(step)
  stepRef.current = step

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 只关弹窗，不冒泡到别的 Esc 监听
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      // 只在焦点真的落在弹窗里时接管方向键（别的地方另有用途：输入历史、列表导航）
      if (!rootRef.current?.contains(document.activeElement)) return
      e.preventDefault()
      e.stopPropagation()
      stepRef.current(e.key === 'ArrowDown' ? 1 : -1)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 打开即把焦点收进弹窗：↑↓ 立刻可用（Esc 挂在 document 上，不依赖焦点）
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  /** 暂存 / 取消暂存当前文件；成功后翻到另一侧 —— 失败就留在原地（错误由 git-service 提示） */
  async function runAction(): Promise<void> {
    const ok = staged ? await unstage([entry.path]) : await stage([entry.path])
    if (!ok) return
    setCurrent((prev) => ({
      entry: prev.entry,
      side: prev.side === 'staged' ? 'unstaged' : 'staged',
    }))
  }

  const rows = useMemo(() => (sides ? gitDiffRows(sides) : []), [sides])
  /** 只有一侧有内容（删除 / 新增 / 未跟踪）→ 另一栏整栏不画（口径 4） */
  const singleSide = useMemo(() => (sides ? singleSideOf(sides) : null), [sides])
  const currentKey = rowKey(side, entry.path)

  return createPortal(
    <div className="git-diff-backdrop" onMouseDown={onClose}>
      <div
        className="git-diff-modal"
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="git-diff-head">
          <span className="git-diff-path" title={displayPath(entry)}>
            {displayPath(entry)}
          </span>
          <span className="git-diff-scope">
            {staged ? t('已暂存的更改') : t('更改')}
          </span>
          <span className="git-spacer" />
          <button
            type="button"
            className="git-diff-action"
            title={actionLabel}
            disabled={disabled}
            onClick={() => void runAction()}>
            {actionLabel}
          </button>
          <button
            type="button"
            className="git-close"
            onClick={onClose}
            title={t('关闭')}>
            ✕
          </button>
        </div>
        <div className="git-diff-main">
          <aside className="git-diff-side">
            {sections.map((section) =>
              section.entries.length === 0 ? null : (
                <div className="git-diff-side-group" key={section.key}>
                  <div className="git-diff-side-title">
                    <span>{section.title}</span>
                    <span className="git-diff-side-count">
                      {section.entries.length}
                    </span>
                  </div>
                  {section.entries.map((row) => {
                    const letter = statusLetter(row, section.side)
                    const name = baseName(row.path)
                    return (
                      <button
                        type="button"
                        key={rowKey(section.side, row.path)}
                        className={`git-diff-side-row${
                          rowKey(section.side, row.path) === currentKey
                            ? ' active'
                            : ''
                        }`}
                        title={displayPath(row)}
                        onClick={() =>
                          setCurrent({ entry: row, side: section.side })
                        }>
                        {/* 与面板的行同一套排布（图标在左、状态字母在右）—— 两处列的是同一份清单 */}
                        <FileTypeIcon
                          filename={name}
                          className="git-diff-side-icon"
                        />
                        <span className="git-diff-side-name">{name}</span>
                        <span className="git-diff-side-dir">
                          {dirName(row.path)}
                        </span>
                        <span className={`git-row-letter s-${letter}`}>
                          {letter}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ),
            )}
          </aside>
          <div className="git-diff-body">
            {loading && <div className="git-diff-message">{t('加载中…')}</div>}
            {!loading && error && (
              <div className="git-diff-message error">{error}</div>
            )}
            {!loading && !error && sides?.binary && (
              <div className="git-diff-message">
                {t('二进制文件，无法显示差异')}
              </div>
            )}
            {!loading && !error && sides && !sides.binary && (
              <>
                {sides.truncated && (
                  <div className="git-diff-message">
                    {tpl('文件过大，仅显示前 $__chars__ 个字符', {
                      chars: 512 * 1024,
                    })}
                  </div>
                )}
                {/* showHeader={false}：路径在弹窗头，全屏按钮在这套「清单 + 差异」布局里也没有意义
                    不传 stat：完整文件的行号是连续的，列头要显示 Ln 区间（口径 5） */}
                <SideBySideDiff
                  diffRows={rows}
                  fileName={entry.path}
                  showHeader={false}
                  singleSide={singleSide ?? undefined}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default GitDiffModal
