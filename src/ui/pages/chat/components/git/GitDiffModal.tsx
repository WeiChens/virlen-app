/**
 * GitDiffModal — 变更文件的左右对比（模态）：**左侧是全部更改文件的清单，右侧是当前文件的差异**。
 *
 * 六条界面口径（P1.3 / P1.4 / 实测反馈）：
 * 1. **路径只出现一次** —— 弹窗头已经写了它，正文（`MonacoDiffView`）不画文件头；
 *    正文**不内置**全屏按钮，全屏由弹窗头那颗 `全屏 / 退出全屏` 统一管（Esc 先退全屏，再一下才关弹窗），
 *    否则两套全屏各管一半，谁在管看不清；
 * 2. **暂存 / 取消暂存就在弹窗里** —— 看完差异顺手处理是最常见的下一步，逼用户关掉弹窗回列表再点一次不合理。
 *    操作成功后视图自动翻到另一侧（暂存 → 看 index↔HEAD，取消暂存 → 看工作区↔index），因为
 *    原来那一侧的差异此刻已经空了；
 * 3. **左侧清单随时切换**（↑↓ 键也行）—— 连着看几个文件的差异不必反复开关弹窗。
 *    清单里的一行与面板的行同一套排布：**图标在左、状态字母在右**（两处列的是同一份清单）；
 * 4. **空的那一侧整栏不画**（实测反馈：被删除的文件不必再显示「新文件」）—— 判定按**内容**
 *    （`domain/git::singleSideOf`）：删除只有旧侧、新增 / 未跟踪只有新侧、未合并取不到的那侧为空。
 *    留半栏空白既占宽度，又让人以为「另一侧是空的」是内容问题；
 * 5. **整文件、不省略**（实测反馈：不要用 … 省略相同的部分）：改动行前后的未改动行照常显示
 *    （改了哪几个字由行内字符级片段标出）。正文一律走 Monaco（`MonacoDiffView`：真虚拟化，
 *    切文件不重建 DOM）：两侧都有内容是左右两栏，只有一侧有内容（新增 / 删除 / 未跟踪）是单栏
 *    —— 空侧那一栏连列头一起不画（口径 4）；后一种形态单栏里的整份内容按「全新增 / 全删除」染色。
 * 6. **头部只剩路径 + 动作**（实测反馈）：原来那颗「基准」胶囊（更改 / 已暂存的更改）取消 ——
 *    它在说的事那颗按钮已经在说（`暂存更改` = 在看工作区侧、`取消暂存` = 在看 index 侧）；
 *    腾出来的位置给「文件过大，仅显示前 N 个字符」那条提示，因为**提示放正文里会顶出滚动条**
 *    （`.git-diff-body > .git-mono-diff` 是 `height: 100%`，上面再压一个兄弟块，内容就比容器高
 *    一截：正文被挤下去 + 多出一条滚动条）。
 * 7. **全屏**（实测反馈）：`全屏 / 退出全屏` 把弹窗铺满遮罩（仍让开自绘标题栏那一条）——
 *    弹窗本来有 `min(1360px, 100%) / min(780px, 100%)` 的上限，宽屏上是「本来就该铺满」，
 *    窄屏上省下的那一圈跑形也归它。
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
  singleSideOf,
  statusLetter,
} from '@/domain/git'
import type { GitChangeEntry, GitDiffSides } from '@/domain/git'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import { MonacoDiffView } from '../message/MonacoDiffView'
import { loadDiffSides, stage, unstage } from '@/services/git-service'
import type { GitRowTarget } from './GitChangeRow'
import { rowKey, type GitChangeSection } from './sections'
import VirtualList from './VirtualList'
import { SideResizer, useSideWidth } from './use-side-width'
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

/** 左清单的扁平条目（虚拟列表按它切窗口）：段标题与文件行混排 */
type SideItem =
  | { kind: 'title'; key: string; section: GitChangeSection }
  | { kind: 'row'; key: string; section: GitChangeSection; entry: GitChangeEntry }

/** 左清单行高（px）—— 与 `.git-diff-side-title` / `.git-diff-side-row` 的固定高度一致 */
const SIDE_ROW_H = 24

export function GitDiffModal({ target, sections, disabled, onClose }: Props) {
  /** 当前展示的文件 + 它属于哪一侧（侧决定差异基准：更改 = 工作区↔index，已暂存 = index↔HEAD） */
  const [current, setCurrent] = useState<GitRowTarget>(target)
  const [sides, setSides] = useState<GitDiffSides | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** 全屏（铺满遮罩）：长文件 / 窄窗时左右对比容易被挤，看完差异再退回去 */
  const [full, setFull] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 左清单宽度（右侧分隔条可拖，记在 localStorage） */
  const sideWidth = useSideWidth()

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

  /** 左清单的虚拟列表输入（段标题与文件行混排；行高相同，直接用常量） */
  const sideItems = useMemo<SideItem[]>(() => {
    const items: SideItem[] = []
    for (const section of sections) {
      if (section.entries.length === 0) continue
      items.push({ kind: 'title', key: `t:${section.key}`, section })
      for (const entry of section.entries) {
        items.push({
          kind: 'row',
          key: `r:${section.key}:${entry.path}`,
          section,
          entry,
        })
      }
    }
    return items
  }, [sections])
  const sideHeights = useMemo(
    () => sideItems.map(() => SIDE_ROW_H),
    [sideItems],
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
        // 全屏状态下 Esc 先退全屏（一次性关掉两层状态会让人觉得「按错了一下就没了」）
        if (full) {
          setFull(false)
          return
        }
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      // 只在焦点真的落在弹窗里时接管方向键（别的地方另有用途：输入历史、列表导航）
      if (!rootRef.current?.contains(document.activeElement)) return
      // 焦点在差异正文里时把方向键让给它（Monaco 用方向键在正文里移动），
      // 在清单 / 弹窗其它位置才是「上下切文件」（口径 3）
      if (document.activeElement?.closest('.monaco-editor')) return
      e.preventDefault()
      e.stopPropagation()
      stepRef.current(e.key === 'ArrowDown' ? 1 : -1)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose, full])

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

  /**
   * 只有一侧有内容（删除 / 新增 / 未跟踪）→ 另一栏整栏不画（口径 4）：交给 `MonacoDiffView` 的
   * 单栏形态（单栏只读编辑器 + 整份内容按全新增 / 全删除染色），两栏形态则走它的差异编辑器。
   * 判定按**内容**（`domain/git::singleSideOf`），不是列表上的状态字母。
   */
  const singleSide = useMemo(() => (sides ? singleSideOf(sides) : null), [sides])
  const currentKey = rowKey(side, entry.path)

  return createPortal(
    <div
      className={`git-diff-backdrop${full ? ' is-fullscreen' : ''}`}
      onMouseDown={onClose}>
      <div
        className={`git-diff-modal${sideWidth.resizing ? ' is-resizing' : ''}${full ? ' is-fullscreen' : ''}`}
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="git-diff-head">
          <span className="git-diff-path" title={displayPath(entry)}>
            {displayPath(entry)}
          </span>
          {/* 截断提示占原来那颗「基准」胶囊的位置（口径 6）：放正文里会把正文顶出滚动条 */}
          {!loading && !error && sides?.truncated && (
            <span className="git-diff-note">
              {tpl('文件过大，仅显示前 $__chars__ 个字符', {
                chars: 512 * 1024,
              })}
            </span>
          )}
          <span className="git-spacer" />
          <button
            type="button"
            className="git-diff-action"
            title={actionLabel}
            disabled={disabled}
            onClick={() => void runAction()}>
            {actionLabel}
          </button>
          {/* 全屏：只看差异时清单与正文都想要更大面积（Esc 先退全屏，再按一下才关弹窗） */}
          <button
            type="button"
            className="git-diff-full"
            title={full ? t('退出全屏') : t('全屏')}
            aria-pressed={full}
            onClick={() => setFull((v) => !v)}>
            {full ? t('退出全屏') : t('全屏')}
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
          {/* 左清单走虚拟列表：文件一多（几千条）不是滚动卡，而是首次渲染就卡在 DOM 数量上 */}
          <VirtualList
            className="git-diff-side"
            style={{ width: sideWidth.width }}
            items={sideItems}
            heights={sideHeights}
            render={(item) => {
              if (item.kind === 'title') {
                return (
                  <div className="git-diff-side-title" key={item.key}>
                    <span>{item.section.title}</span>
                    <span className="git-diff-side-count">
                      {item.section.entries.length}
                    </span>
                  </div>
                )
              }
              const { section, entry: row } = item
              const letter = statusLetter(row, section.side)
              const name = baseName(row.path)
              const rowStaged = section.side === 'staged'
              const label = rowStaged ? t('取消暂存') : t('暂存更改')
              const key = rowKey(section.side, row.path)
              return (
                // ⚠️ 行是 `div role=button` 而不是 `button`：里面有另一颗按钮（暂存 / 取消暂存），
                //    button 套 button 是非法 HTML，浏览器会把内层拆出去
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  className={`git-diff-side-row${key === currentKey ? ' active' : ''}`}
                  title={displayPath(row)}
                  onClick={() => setCurrent({ entry: row, side: section.side })}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    setCurrent({ entry: row, side: section.side })
                  }}>
                  {/* 与面板的行同一套排布（图标在左、状态字母在右）—— 两处列的是同一份清单 */}
                  <FileTypeIcon filename={name} className="git-diff-side-icon" />
                  <span className="git-diff-side-name">{name}</span>
                  <span className="git-diff-side-dir">{dirName(row.path)}</span>
                  {/* 看完差异顺手处理是最常见的下一步（与弹窗头那颗动作同一语义，只是作用于**这一行**） */}
                  <button
                    type="button"
                    className="git-diff-side-act"
                    title={label}
                    aria-label={label}
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      void (rowStaged ? unstage([row.path]) : stage([row.path]))
                    }}>
                    {rowStaged ? '－' : '＋'}
                  </button>
                  <span className={`git-row-letter s-${letter}`}>{letter}</span>
                </div>
              )
            }}
          />
          {/* 右侧分隔条：拖它调清单宽度（键盘聚焦后 ← → 也行） */}
          <SideResizer side={sideWidth} />
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
                {/* 正文一律走 Monaco：两侧都有内容是左右两栏，只有一侧有内容是单栏（口径 4：
                    空侧那一栏连列头一起不画）。两份都不画文件头（showHeader 那套）——
                    路径在弹窗头，内置的全屏按钮在「清单 + 差异」这套布局里也没有意义；
                    列头照旧显示 Ln 区间（口径 5）。 */}
                <MonacoDiffView
                  oldText={sides.old_text ?? ''}
                  newText={sides.new_text ?? ''}
                  fileName={entry.path}
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
