/**
 * memory-settings — 记忆（设置 → 记忆）
 *
 * 只放设置项：每次带上多少条、以及「AI 到底读到了什么」的预览。
 *
 * ⚠️ 记忆**固定启用**：没有总开关。关掉它既不会释放什么（记忆只是一张本地表），也不会让 AI
 * 忘掉什么（关的是「带上」而不是「存下」），却会让人以为记忆丢了 —— 所以这个选项已去掉。
 *
 * ⚠️ 记忆**列表不在这里** —— 列表是逐日变长的数据（点行编辑、复选框 + 批量栏、编辑表单），常驻会把
 * 设置项一路挤到视野之外。列表挪到 `memory/MemoryListModal`；数据仍由本页持有
 * （入口要显示条数），弹窗通过 `onChanged` 让本页重取。
 *
 * ⚠️ 入口在**页尾**而不是页头：设置页的第一屏该先回答「这个页面管什么」（带上多少），列表是数据而不是
 * 设置；顺着一路读完再点进去，比一上来就把两个东西摆在同一层更清楚。
 *
 * 「AI 会读到什么」必须调后端渲染：`# Memory` 段的选取与预算裁剪只有 Rust 一份实现
 * （`agent::memory::select_for_inject` / `render_memory_section`），前端再算一遍就会与模型
 * 实际收到的内容不一致。
 *
 * 页面顺序：注入多少 → 全部记忆（数据）→ 整理记忆 → 详情正文自检。后两块是**维护动作**，
 * 都默认什么都不显示（用户点了才出结果）；整理排在自检前面，因为它更常用（条数涨得比断链快）。
 * 合并的判定与阈值全在 Rust（`agent/memory/redistill`），这里只负责按钮与把报告转成结论句。
 *
 * 语体：结论句一律**书面语**（「检查通过：… 的引用均有效」「未执行：<原因>」「该批次未合并：<原因>」）；
 * 不用「对得上 / 指得着 / 凑不齐 / 不敢 / 没能 / 跑 / 关掉了 / 这批」这类口语 —— 这是报告，不是聊天。
 * 注入口径统一叫「注入」（与 Rust 的 `select_for_inject` 同词），不再用「带上」。
 */
import { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t, tpl } from '@/ui/i18n'
import {
  checkMemoryIntegrity,
  listMemories,
  listMemoryRedistillRuns,
  loadMemorySection,
  purgeMemoryOrphans,
  runMemoryRedistill,
} from '@/infrastructure/memoryRepo'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import {
  MEMORY_NORMAL_TOP_K_MAX,
  MEMORY_REDISTILL_MAX_BATCHES_PER_RUN,
  MEMORY_REDISTILL_MIN_GROUP_ITEMS,
  MEMORY_REDISTILL_TRIGGER_COUNT,
  deletableOrphanCount,
  isIntegrityClean,
  type MemoryDanglingLink,
  type MemoryIntegrityReport,
  type MemoryPromptSection,
  type MemoryRecord,
  type MemoryRedistillReport,
  type MemoryRedistillRun,
} from '@/domain/memory'
import { formatMemoryMinute } from './memory/format'
import MemoryListModal from './memory/MemoryListModal'
import './memory-settings.scss'

/** 自检报告的一句结论（计数由 Rust 给出，前端不自己算「干净不干净」）
 *
 * 语体：报告类文案一律书面语（「引用有效 / 未执行检查」），不用「对得上 / 指得着 / 没能」这类口语。
 */
function integritySummary(report: MemoryIntegrityReport): string {
  if (!report.kbAvailable) {
    return t('知识库暂不可用，本次未执行检查')
  }
  if (isIntegrityClean(report)) {
    return tpl('检查通过：$__memories__ 条记忆、$__docs__ 篇正文的引用均有效', {
      memories: report.checkedMemories,
      docs: report.checkedDocs,
    })
  }
  return tpl('检查结果：$__orphans__ 篇孤儿正文、$__dangling__ 条断链', {
    orphans: report.orphans.length,
    dangling: report.dangling.length,
  })
}

/** 断链的原因（`reason` 是后端给的机器标识） */
function danglingReason(link: MemoryDanglingLink): string {
  if (link.reason === 'kb-mismatch') {
    return t('所属知识库不一致（应用迁移或知识库重建）')
  }
  return link.disabled ? t('正文缺失（该记忆已停用）') : t('正文缺失')
}

// ==================== 整理记忆（再蒸馏）的结果文案 ====================
//
// 合并 / 归档的判定全在 Rust（`agent/memory/redistill`）：前端只把报告转成结论句，
// 不自己推「应该合并了几条」—— 那些数字只能来自实际落库结果。

/** 一批被跳过的原因（`reason` 是后端给的机器标识） */
function redistillReason(reason: string): string {
  switch (reason) {
    case 'no-gain':
      return t('模型判定这些条目合并后没有改进')
    case 'no-rag':
      return t('知识库不可用：无法写入归档，本次不停用旧条目')
    case 'archive-too-long':
      return t('合并后的原文超出单篇归档上限')
    case 'too-few-items':
      return t('该分组可合并的条目不足')
    case 'already-done':
      return t('该批次近期已整理')
    default:
      return reason
  }
}

/**
 * 「被护栏保留的归档」那一句（`count = 0` → 空串，不插噪）。
 *
 * 为何必须说：这些条目既没删掉也**不会再被自动删**（代码不再动它们），只能人工处理。
 * 只把它写进日志，等于让 GUI 用户看到一句「没有需要清理的超期归档」——那句是假的。
 */
function retainedNote(count: number): string {
  return count > 0
    ? tpl('另有 $__count__ 条归档被保留（其指向的新条目已不存在，需手动处理）', { count })
    : ''
}

/** 把「清理结果」与「保留说明」接成一句（保留为 0 时不起第二个分句） */
function withRetained(base: string, retained: number): string {
  const note = retainedNote(retained)
  return note ? `${base}，${note}` : base
}

/** 一轮结果的一句话（数字全由 Rust 给，前端不自己算） */
function redistillSummary(report: MemoryRedistillReport): string {
  switch (report.status) {
    case 'disabled':
      return t('自动整理已关闭（设置项 memoryRedistillEnabled）')
    case 'unavailable':
      return t('本地存储不可用，本次未执行整理')
    case 'no-model':
      return t('没有可用的模型配置，请先在「AI 服务」中配置模型')
    case 'nothing':
      return report.purged > 0
        ? withRetained(
            tpl('没有需要合并的条目，已清理 $__count__ 条超期归档', { count: report.purged }),
            report.purgedRetained,
          )
        : tpl(
            '没有需要整理的条目（同一分组需至少 $__count__ 条才会合并，或该批次近期已整理）',
            { count: MEMORY_REDISTILL_MIN_GROUP_ITEMS },
          )
    default:
      break
  }
  // 只清理归档：没有合并环节
  if (report.task === 'purge') {
    return withRetained(
      report.purged > 0
        ? tpl('已清理 $__count__ 条超期归档', { count: report.purged })
        : t('没有需要清理的超期归档'),
      report.purgedRetained,
    )
  }
  const cleaned =
    report.purged > 0 ? tpl('同时清理了 $__count__ 条超期归档', { count: report.purged }) : ''
  if (report.itemsIn === 0) {
    return cleaned || t('本次没有合并（跳过原因见下）')
  }
  const merged = tpl('整理完成：$__in__ 条合并为 $__out__ 条（模型调用 $__calls__ 次）', {
    in: report.itemsIn,
    out: report.itemsOut,
    calls: report.calls,
  })
  return cleaned ? `${merged}，${cleaned}` : merged
}

/**
 * 从最近几行流水里挑「该告诉用户的那一条」。
 *
 * 一个 `Full` 轮次会写多行：成功的批次（真实指纹）+ 「这批刚整理过 / 凑不齐一批」（`gate:*` 噪声）。
 * 后者是**同一轮里的收尾结果**，拿它当「上次整理」会把刚合并成功的消息盖成「当时没跑」。
 *
 * ⚠️ 但**不能无条件跳过噪声**：如果最近一轮**只**产出了噪声（没合并），那些噪声本身就是答案，
 * 而把它跳过去会让面板拿出几个月前那次成功当「上次整理」（用户现下的问题反而看不见）。
 * 所以只让「与真实行同一轮」的噪声让位 —— 同一轮的行时间戳都等于 `run_at` 的同一个 `now_ms`，
 * 真实行与收尾噪声相差秒级；而两轮之间至少隔着 30 分钟冷却（手动强制重跑也至少隔一次点击）。
 */
const SAME_ROUND_WINDOW_MS = 5 * 60_000

function pickLastRun(runs: MemoryRedistillRun[]): MemoryRedistillRun | null {
  const newest = runs[0]
  if (!newest) return null
  const noisy = new Set(['gate:already-done', 'gate:too-few-items'])
  if (!noisy.has(newest.fingerprint)) return newest
  const at = newest.finishedAt ?? newest.startedAt
  const sameRound = runs.find(
    (r) =>
      !noisy.has(r.fingerprint) &&
      Math.abs((r.finishedAt ?? r.startedAt) - at) <= SAME_ROUND_WINDOW_MS,
  )
  return sameRound ?? newest
}

/**
 * 「上次整理」的一句话（= 最近一条流水）。
 *
 * 为何要显示它：自动整理是**用户无感**的后台动作，没跑也不会报错 —— 用户只能看到「记忆越活越多却
 * 从不合并」，而原因写在流水表里没人看得见（这次排障就是这么摸了一个小时）。
 * `gate:*` 行 = 闸门判定了却没跑（知识库未就绪 / 没模型 / 开关关了 / 条数不够），
 * 它们的 `fingerprint` 后缀就是原因。
 */
function lastRunText(run: MemoryRedistillRun): { text: string; warn: boolean } {
  const at = formatMemoryMinute(run.finishedAt ?? run.startedAt)
  /** 闸门级跳过：原因在 fingerprint 后缀里（Rust 侧 `gate:<reason>`） */
  const gateReason = run.fingerprint.startsWith('gate:') ? run.fingerprint.slice(5) : null
  let text: string
  let warn = run.status === 'failed'
  if (gateReason) {
    switch (gateReason) {
      case 'no-rag':
        text = t('未执行：知识库不可用（无法写入归档，不停用旧条目）')
        break
      case 'no-model':
        text = t('未执行：没有可用的模型配置')
        break
      case 'disabled':
        text = t('未执行：自动整理已关闭')
        break
      case 'unavailable':
        text = t('未执行：本地存储不可用')
        break
      case 'too-few-items':
        text = t('未执行：可归档条目不足一批')
        break
      case 'already-done':
        text = t('未执行：该批次近期已整理')
        break
      default:
        text = run.error || gateReason
    }
    // 「知识库未就绪 / 没模型 / 开关关了」是真问题；「这批刚整理过」是正常结果
    warn = warn || gateReason === 'no-rag' || gateReason === 'no-model' || gateReason === 'disabled'
  } else if (run.fingerprint === 'purge') {
    text = withRetained(
      run.purged > 0
        ? tpl('已清理 $__count__ 条超期归档', { count: run.purged })
        : t('没有需要清理的超期归档'),
      run.purgedRetained,
    )
  } else if (run.status === 'running') {
    text = t('未完成（记录为整理中）')
  } else if (run.status === 'failed') {
    text = tpl('失败：$__error__', { error: run.error || t('未知原因') })
  } else if (run.status === 'done' || run.status === 'partial') {
    text = tpl('合并 $__in__ 条为 $__out__ 条', { in: run.itemsIn, out: run.itemsOut })
  } else {
    // `skipped`：真实批次指纹 + 原因（`no-gain` 等）
    text = tpl('该批次未合并：$__reason__', {
      reason: run.error ? redistillReason(run.error) : t('未知原因'),
    })
  }
  return { text: at ? `${text} · ${at}` : text, warn }
}

/** 跳过原因的汇总（同类只写一次 + 次数，否则 3 批就是 3 行重复） */
function redistillSkipNotes(report: MemoryRedistillReport): string[] {
  const counts = new Map<string, number>()
  for (const b of report.batches) {
    if (b.status !== 'skipped' || !b.reason) continue
    counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1)
  }
  return [...counts].map(([reason, n]) =>
    n > 1 ? `${redistillReason(reason)}（${n} 批）` : redistillReason(reason),
  )
}

function MemorySettings() {
  const [items, setItems] = useState<MemoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState<MemoryPromptSection | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  /** 记忆列表弹窗的开关（列表本体在 `MemoryListModal` 里） */
  const [showList, setShowList] = useState(false)
  /** 详情正文自检的报告；`null` = 还没查过 / 没查成 */
  const [integrity, setIntegrity] = useState<MemoryIntegrityReport | null>(null)
  const [checkingIntegrity, setCheckingIntegrity] = useState(false)
  const [purging, setPurging] = useState(false)
  /** 整理进行中的任务（`null` = 空闲）：两枚按钮共用一个状态，天然互斥 */
  const [redistilling, setRedistilling] = useState<'full' | 'purge' | null>(null)
  /** 上一轮整理的结果；`null` = 还没跑过（不自动跑，也不常驻告警） */
  const [redistillReport, setRedistillReport] = useState<MemoryRedistillReport | null>(null)
  /** 最近一条整理流水（含闸门级跳过）：回答「自动整理到底跑了没」 */
  const [lastRun, setLastRun] = useState<MemoryRedistillRun | null>(null)

  const topK = settingsState.value.memoryNormalTopK

  // 挂载 / 任何写操作之后都重取：预算与状态必须是**当前**状态，而不是「打开面板那一刻」的
  //（用户删了十条还看到告警就是误导）。`true` = 这是一次「看面板」，后端据此不打截断告警埋点。
  const reload = useCallback(async () => {
    setLoading(true)
    const [list, sec, runs] = await Promise.all([
      listMemories(true),
      // 面板没有「会话工作目录」，用设置里的**默认工作目录**当基准：预览与真实会话走同一套
      // 作用域规则，只是工作目录不同（下面会把它显示出来）
      loadMemorySection(true, settingsState.value.defaultWorkspace),
      listMemoryRedistillRuns(5),
    ])
    setItems(list)
    setSection(sec)
    setLastRun(pickLastRun(runs))
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 打开记忆列表弹窗。**每次都重取**：记忆会被 AI 工具（`memory_write`）/ 别的窗口改动，
   * 弹窗里看到的必须是当前状态（顺带刷新本页的预算行）。
   */
  function openList() {
    setShowList(true)
    void reload()
  }

  // 预算告警：被裁过就说明记忆总量已超过能带上的上限（计数由 Rust 侧给出，前端不自己算）
  const hasBudgetWarning =
    !!section && (section.droppedNormal > 0 || section.droppedPermanent > 0)

  /**
   * 核验「记忆 → 详情正文」的引用完整性。
   *
   * 只读、不建库：后端 RAG 不可用时它如实返回 `kbAvailable = false`，面板照实说「未执行检查」，
   * 不把「没检查」显示成「干净」。
   */
  async function runIntegrityCheck() {
    setCheckingIntegrity(true)
    const report = await checkMemoryIntegrity()
    setCheckingIntegrity(false)
    if (!report) {
      showToast(t('检查失败：无法读取记忆详情'), 2000)
      return
    }
    setIntegrity(report)
  }

  /** 清理孤儿正文（只删带「记忆详情」前缀的那几篇；删正文不可撤销，所以先二次确认） */
  async function runPurge() {
    const count = integrity ? deletableOrphanCount(integrity) : 0
    if (count === 0) return
    const confirmed = await MessageBox.propt(
      t('清理孤儿正文'),
      tpl('这 $__count__ 篇正文已无记忆引用，删除后无法恢复，是否继续？', {
        count,
      }),
      { confirmText: t('删除'), cancelText: t('取消'), danger: true },
    )
    if (!confirmed) return
    setPurging(true)
    const report = await purgeMemoryOrphans()
    setPurging(false)
    if (!report) {
      showToast(t('清理失败，请稍后再试'), 2000)
      return
    }
    // 后端在同一个命令里「清 → 重新核验」，所以这份报告就是**现在**的状态
    setIntegrity(report)
    showToast(t('已清理孤儿正文'), 1500)
  }

  const deletableCount = integrity ? deletableOrphanCount(integrity) : 0

  /**
   * 手动跑一轮整理。
   *
   * 不做二次确认：合并掉的旧条目只是**归档**（停用 + 可看、可重新启用，原文进了知识库），
   * 不是不可撤销的删除；二次确认留给「删正文」那种真删不回来的动作。
   * 但按钮旁必须说清「会调模型」（花钱）——这点写在本节说明文字里。
   */
  async function runRedistill(task: 'full' | 'purge') {
    if (redistilling) return
    setRedistilling(task)
    try {
      const report = await runMemoryRedistill({ task })
      if (!report) {
        // 非 Tauri（浏览器 dev）：如实说不可用，不假装整理过了
        showToast(t('当前环境不支持整理记忆'), 2000)
        return
      }
      setRedistillReport(report)
      // 合并 / 清理都会改变条数与注入预算：预算行与「全部记忆（N 条）」必须是当前值。
      // ⚠️ 重取失败**不能**当成整理失败：整理已经生效、报告也已经上屏，说「整理失败」是谎报
      //（而且用户会以为要重跑一次、再花一次钱）。读接口本已各自降级，这里只保库。
      try {
        await reload()
      } catch (e: any) {
        console.warn(`[memory] 整理后刷新失败（整理结果已生效）：${e?.message || String(e)}`)
      }
    } catch (e: any) {
      // 后端把原因放在 message 里（典型：后台整理正在进行中），不能吐成一句「失败」
      showToast(`${t('整理失败')}：${e?.message || String(e)}`, 3000)
    } finally {
      setRedistilling(null)
    }
  }

  /** 这一轮有没有「没干成」的部分（结果块据此染上告警色）
   *
   * `nothing` **不算**告警：「没有需要整理的条目」是正常结果，染红会让人以为出了错。
   * 真正要醒目的是「功能被关 / 库不可用 / 没模型」与有批次失败。 */
  const redistillWarn =
    !!redistillReport &&
    (redistillReport.status === 'disabled' ||
      redistillReport.status === 'unavailable' ||
      redistillReport.status === 'no-model' ||
      redistillReport.batches.some((b) => b.status === 'failed'))
  const redistillNotes = redistillReport ? redistillSkipNotes(redistillReport) : []
  /** 跳过的批次数 —— 与 `redistillNotes.length` 不是一回事（同一个原因可能命中好几批） */
  const redistillSkippedBatches = redistillReport
    ? redistillReport.batches.filter((b) => b.status === 'skipped').length
    : 0
  /** 最近一条流水的一句话（未跑过 / 读不到流水时为 `null`，那就整行都不渲染） */
  const lastRunInfo = lastRun ? lastRunText(lastRun) : null

  return (
    <div className="memory-settings">
      <header className="memory-header">
        <div className="memory-header-text">
          <h2 className="section-title">{t('记忆')}</h2>
          <p className="memory-page-desc">
            {t('AI 会记住你提供的偏好与项目约定，并在新对话中自动注入相关条目。')}
          </p>
        </div>
      </header>

      {/* ==================== 每次对话注入的条数 ==================== */}
      <section className="memory-group">
        <div className="memory-group-title">{t('每次对话注入多少')}</div>
        <div className="memory-option-row">
          <label className="memory-num">
            <span>{t('自动注入')}</span>
            <input
              type="number"
              min={1}
              max={MEMORY_NORMAL_TOP_K_MAX}
              value={topK}
              aria-label={t('每次对话自动注入的记忆条数')}
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
            {tpl('最多 $__max__ 条', { max: MEMORY_NORMAL_TOP_K_MAX })}
          </span>
        </div>

        {section && (
          <div className="memory-inject-row">
            <span className={`memory-budget-row${hasBudgetWarning ? ' is-warn' : ''}`}>
              {tpl('本次对话注入 $__injected__ 条记忆（共 $__total__ 条）', {
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
              {showPreview ? t('收起') : t('预览注入内容')}
            </button>
          </div>
        )}

        {section && hasBudgetWarning && (
          <div className="memory-preview-warn">
            {tpl('超出本次注入预算：未带上永久 $__permanent__ 条、普通 $__normal__ 条', {
              permanent: section.droppedPermanent,
              normal: section.droppedNormal,
            })}
            <span className="memory-preview-warn-hint">
              {t('「永久」记忆每次全量注入，建议删除不再需要的条目，或将不常回顾的改为「普通」。')}
            </span>
          </div>
        )}

        {showPreview && section && (
          <div className="memory-preview">
            <pre className="memory-preview-body">
              {section.text || t('（当前没有会被注入的记忆）')}
            </pre>
          </div>
        )}

        {/* 限定了项目的记忆（任何分类都可能带项目路径）的可见性取决于**工作目录**：面板没有会话，
            按默认工作目录算 —— 不写出来用户会以为「记忆怎么少了」（预览里没有它只是因为目录不命中）。 */}
        <div className="memory-scope-note">
          {settingsState.value.defaultWorkspace
            ? tpl('限定了项目的记忆仅在对应项目的对话中注入（当前按 $__path__ 判断）', {
                path: settingsState.value.defaultWorkspace,
              })
            : t('尚未设置默认工作目录，限定了项目的记忆暂不注入（可在「聊天」中设置）')}
        </div>
      </section>

      {/* 全部记忆的入口（**页尾**，列表的唯一入口）：页面从上到下是「带上多少 → 看/改全部」，
          读完全部的设置项再看见它；做成一行式卡片（整行可点）而不是主色按钮 ——
          它通向的是「看数据」，不是「新建 / 保存」这类动作。 */}
      <button type="button" className="memory-list-entry" onClick={openList}>
        <span className="memory-list-entry-main">
          <span className="memory-list-entry-title">
            {tpl('全部记忆（$__count__ 条）', { count: items.length })}
          </span>
        </span>
        <span className="memory-list-entry-arrow" aria-hidden="true">
          ›
        </span>
      </button>

      {/* 整理记忆（页尾维护动作，排在自检之前：条数涨得比断链快，它是更常用的那个）。
          合并是「旧条目归档 + 新条目」而不是删除，所以不给破坏确认；但会真的调模型，
          说明文字必须把「调用次数 / 会产生费用」说出来。 */}
      <section className="memory-group">
        <div className="memory-group-title">{t('整理记忆')}</div>
        <p className="memory-page-desc">
          {tpl(
            '同一事项被记录为多条时，整理会将其合并为一条，旧条目归档保留（内容不丢失）。候选达到 $__count__ 条时自动整理，也可立即执行：将调用模型（最多 $__batches__ 次），可能产生费用。',
            {
              count: MEMORY_REDISTILL_TRIGGER_COUNT,
              batches: MEMORY_REDISTILL_MAX_BATCHES_PER_RUN,
            },
          )}
        </p>
        {lastRunInfo && (
          <div
            className={`memory-redistill-last${lastRunInfo.warn ? ' is-warn' : ''}`}>
            <span className="memory-redistill-last-title">{t('上次整理')}</span>
            <span className="memory-redistill-last-text">{lastRunInfo.text}</span>
          </div>
        )}

        <div className="memory-redistill-actions">
          <button
            type="button"
            className="memory-option-link"
            disabled={redistilling !== null}
            onClick={() => void runRedistill('full')}>
            {redistilling === 'full' ? t('正在整理…') : t('立即整理')}
          </button>
          <button
            type="button"
            className="memory-option-link"
            disabled={redistilling !== null}
            onClick={() => void runRedistill('purge')}>
            {redistilling === 'purge' ? t('正在清理归档…') : t('只清理归档')}
          </button>
          {redistilling !== null && (
            <span className="memory-option-hint">{t('预计需要数十秒')}</span>
          )}
        </div>

        {redistillReport && (
          <div className={`memory-redistill-report${redistillWarn ? ' is-warn' : ''}`}>
            <div className="memory-redistill-summary">
              {redistillSummary(redistillReport)}
            </div>
            {redistillNotes.length > 0 && (
              <div className="memory-redistill-note">
                {tpl('跳过 $__count__ 批：$__notes__', {
                  count: redistillSkippedBatches,
                  notes: redistillNotes.join('；'),
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 详情正文自检（**页尾**，属于维护动作）：记忆只存摘要，正文在知识库里 ——
          那条链接断掉是静默的，只能主动核验。默认不自动跑，用户点才查。 */}
      <section className="memory-group">
        <div className="memory-group-title">{t('详情正文自检')}</div>
        <p className="memory-page-desc">
          {t('记忆的详情正文存放在知识库中，条目仅保留引用。此处检查这些引用是否仍能定位到正文。')}
        </p>
        <div className="memory-integrity-actions">
          <button
            type="button"
            className="memory-option-link"
            disabled={checkingIntegrity}
            onClick={() => void runIntegrityCheck()}>
            {checkingIntegrity ? t('正在检查…') : t('检查一遍')}
          </button>
          {deletableCount > 0 && (
            <button
              type="button"
              className="memory-option-link is-danger"
              disabled={purging}
              onClick={() => void runPurge()}>
              {purging
                ? t('正在清理…')
                : tpl('清理 $__count__ 篇孤儿正文', { count: deletableCount })}
            </button>
          )}
        </div>

        {integrity && (
          <div
            className={`memory-integrity-report${isIntegrityClean(integrity) ? '' : ' is-warn'}`}>
            <div className="memory-integrity-summary">{integritySummary(integrity)}</div>

            {integrity.orphans.length > 0 && (
              <div className="memory-integrity-list">
                <div className="memory-integrity-list-title">
                  {t('孤儿正文（未被任何记忆引用）')}
                </div>
                {integrity.orphans.map((o) => (
                  <div key={o.docId} className="memory-integrity-item" title={o.docName}>
                    <span className="memory-integrity-item-name">{o.docName}</span>
                    {!o.looksLikeDetail && (
                      <span className="memory-integrity-item-note">
                        {t('非记忆详情文档，请人工确认')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {integrity.dangling.length > 0 && (
              <div className="memory-integrity-list">
                <div className="memory-integrity-list-title">
                  {t('断链（记忆声明有正文但无法读取）')}
                </div>
                {integrity.dangling.map((d) => (
                  <div
                    key={`${d.memoryId}:${d.docId}`}
                    className="memory-integrity-item"
                    title={d.summary}>
                    <span className="memory-integrity-item-name">{d.summary}</span>
                    <span className="memory-integrity-item-note">{danglingReason(d)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

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
