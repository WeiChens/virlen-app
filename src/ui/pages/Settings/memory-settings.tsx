/**
 * memory-settings — 记忆（设置 → 记忆）
 *
 * 只放设置项：每次带上多少条、整理过去的对话、以及「AI 到底读到了什么」的预览。
 *
 * ⚠️ 记忆**固定启用**：没有总开关。关掉它既不会释放什么（记忆只是一张本地表），也不会让 AI
 * 忘掉什么（关的是「带上」而不是「存下」），却会让人以为记忆丢了 —— 所以这个选项已去掉。
 *
 * ⚠️ 记忆**列表不在这里** —— 列表是逐日变长的数据（悬停才显形的操作、复选框 + 批量栏、编辑
 * 表单），常驻会把设置项一路挤到视野之外。列表挪到 `memory/MemoryListModal`；数据仍由本页持有
 * （入口要显示条数），弹窗通过 `onChanged` 让本页重取。
 *
 * ⚠️ 入口在**页尾**而不是页头：设置页的第一屏该先回答「这个页面管什么」（带上多少 / 怎么整理），
 * 列表是数据而不是设置；顺着一路读完再点进去，比一上来就把两个东西摆在同一层更清楚。
 *
 * 「AI 会读到什么」必须调后端渲染：`# Memory` 段的选取与预算裁剪只有 Rust 一份实现
 * （`agent::memory::select_for_inject` / `render_memory_section`），前端再算一遍就会与模型
 * 实际收到的内容不一致。同理「整理」的结果只依据后端返回的报告，不在这里猜「应该产出几条」。
 */
import { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import {
  consolidateMemories,
  listMemories,
  listMemoryRuns,
  loadMemorySection,
} from '@/infrastructure/memoryRepo'
import {
  MEMORY_NORMAL_TOP_K_MAX,
  type ConsolidateReport,
  type MemoryPromptSection,
  type MemoryRecord,
  type MemoryRun,
} from '@/domain/memory'
import MemoryListModal from './memory/MemoryListModal'
import './memory-settings.scss'

/** 本地「昨天」（`YYYY-MM-DD`）—— 与 Rust 侧本地日口径一致（面板按钮按昨天整理） */
function yesterdayString(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 状态行文案：最近一次整理是什么结果（用户最需要知道的就是「它到底跑了没 / 为什么没产出」） */
function runStatusText(latest: MemoryRun | undefined): string {
  if (!latest) return t('还没整理过 —— 点右边的按钮，让 AI 回顾一下昨天的对话')
  switch (latest.status) {
    case 'running':
      return tpl('正在整理 $__day__…', { day: latest.day })
    case 'done':
    case 'partial':
      // 「合并 N 条」只在真的发生过时出现（否则是噪音）—— 它回答的是「说好的记忆怎么没变多」
      if ((latest.merged ?? 0) > 0) {
        return tpl('上次整理 $__day__：新增 $__items__ 条，合并 $__merged__ 条', {
          day: latest.day,
          items: latest.items,
          merged: latest.merged,
        })
      }
      return tpl('上次整理 $__day__：新增 $__items__ 条记忆', {
        day: latest.day,
        items: latest.items,
      })
    case 'skipped':
      return tpl('上次整理 $__day__：那天没有可以整理的对话', { day: latest.day })
    default:
      return tpl('上次整理 $__day__ 没成功：$__error__', {
        day: latest.day,
        error: latest.error || t('原因未知'),
      })
  }
}

/** 整理报告的短文案（一次性提示；`status` 是总体状态，具体到天看 `days[0]`） */
function reportMessage(report: ConsolidateReport | null): string {
  if (!report) return t('整理没跑成功，可以在日志里看到原因')
  switch (report.status) {
    case 'disabled':
      return t('记忆功能当前不可用，这次没有整理')
    case 'unavailable':
      return t('读不到本地数据，这次没有整理')
    case 'no-model':
      return t('还没有可用的模型 —— 先去「模型服务」里配一个')
    case 'nothing':
      return t('没有找到可以整理的对话')
    default:
      break
  }
  const day = report.days[0]
  if (!day) return t('没有找到可以整理的对话')
  switch (day.status) {
    case 'done':
    case 'partial':
      if ((day.merged ?? 0) > 0) {
        return tpl('已整理 $__day__：新增 $__items__ 条记忆，合并 $__merged__ 条', {
          day: day.day,
          items: day.items,
          merged: day.merged,
        })
      }
      return tpl('已整理 $__day__：新增 $__items__ 条记忆', {
        day: day.day,
        items: day.items,
      })
    case 'skipped':
      return tpl('$__day__ 没有可以整理的对话，已跳过', { day: day.day })
    default:
      return tpl('$__day__ 没有整理成功：$__error__', {
        day: day.day,
        error: day.error || t('原因未知'),
      })
  }
}

function MemorySettings() {
  const [items, setItems] = useState<MemoryRecord[]>([])
  const [runs, setRuns] = useState<MemoryRun[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState<MemoryPromptSection | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  /** 记忆列表弹窗的开关（列表本体在 `MemoryListModal` 里） */
  const [showList, setShowList] = useState(false)

  const topK = settingsState.value.memoryNormalTopK

  // 挂载 / 任何写操作之后都重取：预算与状态必须是**当前**状态，而不是「打开面板那一刻」的
  //（用户删了十条还看到告警就是误导）。`true` = 这是一次「看面板」，后端据此不打截断告警埋点。
  const reload = useCallback(async () => {
    setLoading(true)
    const [list, runList, sec] = await Promise.all([
      listMemories(true),
      listMemoryRuns(10),
      // 面板没有「会话工作目录」，用设置里的**默认工作目录**当基准：预览与真实会话走同一套
      // 作用域规则，只是工作目录不同（下面会把它显示出来）
      loadMemorySection(true, settingsState.value.defaultWorkspace),
    ])
    setItems(list)
    setRuns(runList)
    setSection(sec)
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 打开记忆列表弹窗。**每次都重取**：记忆会被后台整理（启动时的非阻塞整理）/ 别的窗口改动，
   * 弹窗里看到的必须是当前状态（顺带刷新本页的预算行）。
   */
  function openList() {
    setShowList(true)
    void reload()
  }

  /** 触发一次整理（`force` = 重跑指定日；默认按「整理昨天的对话」） */
  async function handleConsolidate(day: string | null, force: boolean) {
    setBusy(true)
    const report = await consolidateMemories(day, force)
    setBusy(false)
    showToast(reportMessage(report), 3000)
    await reload()
  }

  // 预算告警：被裁过就说明记忆总量已超过能带上的上限（计数由 Rust 侧给出，前端不自己算）
  const hasBudgetWarning =
    !!section && (section.droppedNormal > 0 || section.droppedPermanent > 0)

  return (
    <div className="memory-settings">
      <header className="memory-header">
        <div className="memory-header-text">
          <h2 className="section-title">{t('记忆')}</h2>
          <p className="memory-page-desc">
            {t(
              'AI 会记住你告诉过它的事：偏好、项目约定、常用做法。开新对话时，相关的记忆会自动带上，你不用反复交代。',
            )}
          </p>
        </div>
      </header>

      {/* ==================== 每次对话带上多少 ==================== */}
      <section className="memory-group">
        <div className="memory-group-title">{t('每次对话带上多少')}</div>
        <div className="memory-option-row">
          <label className="memory-num">
            <span>{t('每次对话自动带上')}</span>
            <input
              type="number"
              min={1}
              max={MEMORY_NORMAL_TOP_K_MAX}
              value={topK}
              aria-label={t('每次对话自动带上的记忆条数')}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) {
                  settingsState.setValue(
                    'memoryNormalTopK',
                    Math.min(Math.max(1, Math.round(n)), MEMORY_NORMAL_TOP_K_MAX),
                  )
                }
              }}
            />
            <span>{t('条记忆')}</span>
          </label>
          <span className="memory-option-hint">
            {tpl('最多 $__max__ 条 —— 带得越多，占用的对话空间越多。', {
              max: MEMORY_NORMAL_TOP_K_MAX,
            })}
          </span>
        </div>

        {section && (
          <div className="memory-inject-row">
            <span className={`memory-budget-row${hasBudgetWarning ? ' is-warn' : ''}`}>
              {tpl('本次对话会带上 $__injected__ 条记忆（共 $__total__ 条）', {
                injected: section.ids.length,
                total: items.length,
              })}
              <span className="memory-budget-chars">
                {tpl('· 内容长度 $__chars__ / $__budget__ 字符', {
                  chars: section.chars,
                  budget: section.budget,
                })}
              </span>
            </span>
            <button
              className="memory-option-link"
              onClick={() => setShowPreview((v) => !v)}
              aria-expanded={showPreview}>
              {showPreview ? t('收起') : t('查看 AI 会读到什么')}
            </button>
          </div>
        )}

        {section && hasBudgetWarning && (
          <div className="memory-preview-warn">
            {tpl('记忆有点多，这次没能全部带上：漏掉永久 $__permanent__ 条、普通 $__normal__ 条', {
              permanent: section.droppedPermanent,
              normal: section.droppedNormal,
            })}
            <span className="memory-preview-warn-hint">
              {t(
                '「永久」每次都会全量带上，所以建议删掉用不到的，或把不常回顾的改成「普通」。',
              )}
            </span>
          </div>
        )}

        {showPreview && section && (
          <div className="memory-preview">
            <div className="memory-preview-title">
              {t('AI 每次会读到的记忆内容')}
            </div>
            <pre className="memory-preview-body">
              {section.text || t('（现在还没有会被带上的记忆）')}
            </pre>
          </div>
        )}
      </section>

      {/* ==================== 整理过去的对话 ==================== */}
      <section className="memory-group">
        <div className="memory-group-title">{t('整理记忆')}</div>
        <p className="memory-hint">
          {t(
            '整理时，AI 会回顾那一天的对话，把值得长期记住的内容写成一条条记忆。同一天只会整理一次；内容很长时，正文会存进知识库，记忆里只留一句摘要。',
          )}
        </p>
        <div className="memory-run-row">
          <button
            className="memory-action-btn primary"
            disabled={busy}
            onClick={() => handleConsolidate(yesterdayString(), false)}>
            {busy ? t('整理中…') : t('整理昨天的对话')}
          </button>
          <span className="memory-run-status">{runStatusText(runs[0])}</span>
        </div>
        {runs[0]?.status === 'failed' && runs[0]?.error && (
          <div className="memory-preview-warn">
            {tpl('上次整理没成功：$__error__', { error: runs[0].error })}
            <button
              className="memory-action-btn"
              disabled={busy}
              onClick={() => handleConsolidate(runs[0].day, true)}>
              {t('再试一次')}
            </button>
          </div>
        )}

        {/* 「项目」类记忆的可见性取决于**工作目录**：面板没有会话，按默认工作目录算 —— 不写出来
            用户会以为「记忆怎么少了」（预览里没有它，只是因为工作目录不命中） */}
        <div className="memory-scope-note">
          {settingsState.value.defaultWorkspace
            ? tpl('属于某个项目的记忆，只会在该项目里的对话中带上（当前按 $__path__ 判断）', {
                path: settingsState.value.defaultWorkspace,
              })
            : t('还没设默认工作目录，所以「项目」类的记忆暂时不会被带上（可在「Agent」里设置）')}
        </div>
      </section>

      {/* 全部记忆的入口（**页尾**，列表的唯一入口）：页面从上到下是「带上多少 → 怎么整理 →
          看/改全部」，读完全部的设置项再看见它；做成一行式卡片（整行可点）而不是主色按钮 ——
          它通向的是「看数据」，不是「新建 / 保存」这类动作。 */}
      <button type="button" className="memory-list-entry" onClick={openList}>
        <span className="memory-list-entry-main">
          <span className="memory-list-entry-title">
            {tpl('全部记忆（$__count__ 条）', { count: items.length })}
          </span>
          <span className="memory-list-entry-hint">
            {t('点开可以逐条查看、改内容或删掉')}
          </span>
        </span>
        <span className="memory-list-entry-arrow" aria-hidden="true">
          ›
        </span>
      </button>

      {/* 记忆列表弹窗：数据与刷新回调都由本页给，弹窗只管交互 */}
      <MemoryListModal
        visible={showList}
        onClose={() => setShowList(false)}
        items={items}
        loading={loading}
        onChanged={reload}
      />
    </div>
  )
}

export default observer(MemorySettings)
