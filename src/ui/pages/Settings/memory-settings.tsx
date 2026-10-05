/**
 * memory-settings — 长期记忆**设置**页（记忆功能 P0 / P2 / P3）
 *
 * 本页只放设置项：开关、注入条数、注入预览、注入预算（常驻行 + 告警）、整理（立即整理昨天 +
 * 状态行 + 失败重跑）。
 *
 * ⚠️ 记忆**列表不在这里**：列表是逐日变长的数据（每行有悬停才显形的操作、复选框 + 批量栏、
 * 编辑表单），常驻会把上面这些设置项一路挤到视野之外 —— 而用户点进「记忆」要改的通常是设置，
 * 不是每次审一遍列表。列表挪到 `memory/MemoryListModal`，点「记忆列表（N 条）」打开。
 * 列表数据仍由本页持有（入口按钮要显示条数、预算行要显示「共 N 条」），弹窗通过 `onChanged` 回调
 * 让本页重取 —— 于是预算告警永远反映**当前**状态，而不是「打开弹窗那一刻的状态」。
 *
 * 为什么「注入预览」要调后端渲染：`# Memory` 段的选取与预算裁剪只有 Rust 一份实现
 * （`agent::memory::select_for_inject` / `render_memory_section`），前端只展示它的产物 ——
 * 若在此处再算一遍，用户看到的将不是模型实际收到的内容。
 * 同理，「整理」的结果也**只**依据后端返回的报告（不在这里猜「应该产出了几条」）。
 */
import { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t, tpl } from '@/ui/i18n'
import Toggle from '@/ui/components/shared/Toggle'
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
  if (!latest) return t('尚未整理过（记忆不会自动长出来）')
  switch (latest.status) {
    case 'running':
      return tpl('正在整理 $__day__…', { day: latest.day })
    case 'done':
    case 'partial':
      // 「合并 N 条」只在真的发生过时出现（否则是噪音）—— 它回答的是「说好的记忆怎么没变多」
      if ((latest.merged ?? 0) > 0) {
        return tpl('上次整理：$__day__，产出 $__items__ 条，合并 $__merged__ 条', {
          day: latest.day,
          items: latest.items,
          merged: latest.merged,
        })
      }
      return tpl('上次整理：$__day__，产出 $__items__ 条（$__details__ 条详情）', {
        day: latest.day,
        items: latest.items,
        details: latest.details,
      })
    case 'skipped':
      return tpl('上次整理：$__day__，当天没有可用的对话素材', { day: latest.day })
    default:
      return tpl('上次整理 $__day__ 失败：$__error__', {
        day: latest.day,
        error: latest.error || t('未知原因'),
      })
  }
}

/** 整理报告的短文案（一次性提示；`status` 是总体状态，具体到天看 `days[0]`） */
function reportMessage(report: ConsolidateReport | null): string {
  if (!report) return t('整理失败（请查看日志）')
  switch (report.status) {
    case 'disabled':
      return t('记忆功能已关闭，未做任何整理')
    case 'unavailable':
      return t('本地存储不可用，未做任何整理')
    case 'no-model':
      return t('没有可用的模型配置（请先在设置里配置服务商）')
    case 'nothing':
      return t('没有需要整理的日期')
    default:
      break
  }
  const day = report.days[0]
  if (!day) return t('没有需要整理的日期')
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
      return tpl('已整理 $__day__：新增 $__items__ 条记忆（$__details__ 条详情）', {
        day: day.day,
        items: day.items,
        details: day.details,
      })
    case 'skipped':
      return tpl('$__day__ 没有可用的对话素材，已跳过', { day: day.day })
    default:
      return tpl('$__day__ 整理失败：$__error__', {
        day: day.day,
        error: day.error || t('未知原因'),
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

  const enabled = settingsState.value.memoryEnabled
  const topK = settingsState.value.memoryNormalTopK

  // 挂载 / 任何写操作之后都重取注入段：预算告警必须是**当前**状态，
  // 而不是「打开面板那一刻的状态」（用户删了十条还看到告警就是误导）。
  // `true` = 这是一次「看面板」，后端据此不打截断告警埋点（否则指标会被面板刷高）。
  const reload = useCallback(async () => {
    setLoading(true)
    const [list, runList, sec] = await Promise.all([
      listMemories(true),
      listMemoryRuns(10),
      // 面板没有「会话工作目录」，用设置里的**默认工作目录**当基准：
      // 预览与真实会话走同一套作用域规则，只是工作目录不同（下面会把它显示出来）。
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
   * 打开记忆列表弹窗。
   *
   * **每次都重取**：记忆会被后台整理（启动时的非阻塞整理）/ 别的窗口改动，弹窗里看到的必须是
   * 库里的当前状态（顺带让本页的预算行跟着刷新）。
   */
  function openList() {
    setShowList(true)
    void reload()
  }

  /** 触发一次整理（`force` = 重跑指定日；默认按「立即整理昨天」） */
  async function handleConsolidate(day: string | null, force: boolean) {
    setBusy(true)
    const report = await consolidateMemories(day, force)
    setBusy(false)
    showToast(reportMessage(report), 3000)
    await reload()
  }

  // 预算告警：被裁过就说明记忆总量已超过注入能力（计数由 Rust 侧给出，前端不自己算）
  const hasBudgetWarning =
    !!section && (section.droppedNormal > 0 || section.droppedPermanent > 0)

  return (
    <div className="memory-settings">
      <div className="memory-header">
        <h2 className="section-title">{t('长期记忆')}</h2>
        <div className="memory-header-actions">
          {/* 列表的**唯一**入口：设置页上只留设置项，记忆条目点这里看 */}
          <button className="memory-add-btn" onClick={openList}>
            {tpl('记忆列表（$__count__ 条）', { count: items.length })}
          </button>
        </div>
      </div>

      <p className="memory-hint">
        {t(
          '记忆会在新建会话时注入系统提示词：永久记忆全量注入，普通记忆按命中次数与时间取前 20 条；' +
            '项目记忆只在会话工作目录命中它的项目路径（或在其子目录下）时注入。',
        )}
      </p>

      <div className="memory-switch-row">
        <Toggle
          checked={enabled}
          onChange={(v) => settingsState.setValue('memoryEnabled', v)}
          ariaLabel={t('启用记忆')}
        />
        <span className="memory-switch-label">{t('启用记忆')}</span>
        <label className="memory-num">
          <span>{t('注入条数（普通记忆）')}</span>
          <input
            type="number"
            min={1}
            max={MEMORY_NORMAL_TOP_K_MAX}
            value={topK}
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
        </label>
        <button className="memory-action-btn" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? t('收起注入预览') : t('查看注入预览')}
        </button>
      </div>

      {section && (
        <div className={`memory-budget-row${hasBudgetWarning ? ' is-warn' : ''}`}>
          {tpl('注入段 $__chars__ / $__budget__ 字符 · 已注入 $__injected__ 条 / 共 $__total__ 条', {
            chars: section.chars,
            budget: section.budget,
            injected: section.ids.length,
            total: items.length,
          })}
        </div>
      )}
      {section && hasBudgetWarning && (
        <div className="memory-preview-warn">
          {tpl(
            '记忆总量已超过注入预算，本次未注入：永久 $__permanent__ 条 / 普通 $__normal__ 条',
            {
              permanent: section.droppedPermanent,
              normal: section.droppedNormal,
            },
          )}
          <span className="memory-preview-warn-hint">
            {t('建议降级为普通、停用或删除部分记忆（永久记忆全量注入）')}
          </span>
        </div>
      )}

      <div className="memory-run-row">
        <button
          className="memory-action-btn primary"
          disabled={busy}
          onClick={() => handleConsolidate(yesterdayString(), false)}>
          {busy ? t('整理中…') : t('立即整理昨天')}
        </button>
        <button
          className="memory-action-btn"
          disabled={busy || !enabled}
          onClick={() => void reload()}>
          {t('刷新')}
        </button>
        <span className="memory-run-status">{runStatusText(runs[0])}</span>
      </div>
      <p className="memory-hint">
        {t(
          '整理会读取各会话在指定日期的摘要（没有摘要时用对话摘录），用模型提炼成上面的记忆条目。' +
            '同一天只整理一次；重要且庞大的内容会存进知识库「记忆详情」，条目里只留链接。',
        )}
      </p>
      {runs[0]?.status === 'failed' && runs[0]?.error && (
        <div className="memory-preview-warn">
          {tpl('上次整理失败：$__error__', { error: runs[0].error })}
          <button
            className="memory-action-btn"
            disabled={busy}
            onClick={() => handleConsolidate(runs[0].day, true)}>
            {t('重新整理这一天')}
          </button>
        </div>
      )}

      {/* 项目记忆的可见性取决于**工作目录**：面板没有会话，按默认工作目录算 —— 不写出来
          用户会以为「记忆怎么少了」（项目记忆没出现在预览里其实是因为工作目录不命中） */}
      <div className="memory-budget-row">
        {settingsState.value.defaultWorkspace
          ? tpl('项目记忆按默认工作目录 $__path__ 计算（只在该项目内的会话里注入）', {
              path: settingsState.value.defaultWorkspace,
            })
          : t('未设默认工作目录：项目记忆一律不注入（可在设置里给 Agent 配一个）')}
      </div>

      {showPreview && section && (
        <div className="memory-preview">
          <div className="memory-preview-title">{t('注入预览')}</div>
          <pre className="memory-preview-body">
            {section.text || t('（当前没有可注入的记忆）')}
          </pre>
        </div>
      )}

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
