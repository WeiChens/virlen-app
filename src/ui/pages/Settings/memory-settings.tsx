/**
 * memory-settings — 长期记忆面板（记忆功能 P0 / P2 / P3）
 *
 * P0 范围：列表（永久 / 普通分区）、手动新增/编辑/删除、级别切换、单条停用、开关与注入条数、注入预览。
 * P2 范围：蒸馏整理（状态行 + 「立即整理昨天」按钮）—— 「第二天自动整理」也在启动时非阻塞触发。
 * P3 范围：注入预算**常驻行 + 告警**（不用点预览就知道记忆有没有挤爆上下文）、导出 JSON、
 * 「合并 N 条」（近重复合并的可见性）。
 *
 * 列表交互（本次）：**多选 + 批量操作**。行内单条操作只在悬停 / 键盘聚焦时显形 —— 每行常驻
 * 4 个按钮会把列表变成噪音；而记忆是「逐日变多、需要定期清理」的数据，清理这类事一次动一批。
 * 每行左侧有复选框、**点整行也能切换选中**，顶部批量栏贴在标题下方随滚动常驻，未选中时不占位。
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
import Select, { type SelectOption } from '@/ui/components/shared/Select'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import {
  consolidateMemories,
  deleteMemory,
  exportMemories,
  listMemories,
  listMemoryRuns,
  loadMemorySection,
  setMemoryDisabled,
  setMemoryLevel,
  upsertMemory,
} from '@/infrastructure/memoryRepo'
import {
  MEMORY_KINDS,
  MEMORY_NORMAL_TOP_K_MAX,
  MEMORY_SUMMARY_HINT_CHARS,
  MEMORY_SUMMARY_MAX_CHARS,
  type ConsolidateReport,
  type MemoryExportFile,
  type MemoryKind,
  type MemoryLevel,
  type MemoryPromptSection,
  type MemoryRecord,
  type MemoryRun,
} from '@/domain/memory'
import './memory-settings.scss'

/** 草稿（新增 / 编辑共用一份表单状态） */
interface MemoryDraft {
  id?: string
  summary: string
  kind: MemoryKind
  level: MemoryLevel
  disabled: boolean
  /** 详情链接（P0 不在表单里编辑，但要**原样回传** —— 否则编辑摘要会把 P2 写的详情链静默清空） */
  detailKbId?: string | null
  detailDocId?: string | null
}

/** 分类的中文名（UI 文案走 i18n；存储值永远是英文枚举） */
const KIND_LABELS: Record<MemoryKind, string> = {
  user: t('用户偏好'),
  project: t('项目'),
  decision: t('决策'),
  fact: t('事实'),
}

/** 分类下拉（走共享 `Select`，与其它设置页同一套控件；`value` 永远是存储用的英文枚举） */
const KIND_OPTIONS: SelectOption[] = MEMORY_KINDS.map((k) => ({
  value: k,
  label: KIND_LABELS[k],
}))

/** 级别下拉（普通 / 永久 = 注入策略，别用「低 / 高」这类含糊说法） */
const LEVEL_OPTIONS: SelectOption[] = [
  { value: 'normal', label: t('普通') },
  { value: 'permanent', label: t('永久') },
]

function emptyDraft(): MemoryDraft {
  return { summary: '', kind: 'project', level: 'normal', disabled: false }
}

/** 共享的空选中集（**只读**：每次改动都新建一份，绝不原地改） */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>()

/** 批量操作种类（与单条操作同语义，只是作用在一批上） */
type BatchOp = 'permanent' | 'normal' | 'disable' | 'enable' | 'delete'

/**
 * 这一个操作会不会**真的改动**这条记忆。
 *
 * 用途有两处：批量栏按钮的可用性，以及真实操作的条数 —— 选中 5 条里 3 条本来就是永久时，
 * 「升级为永久」只该动剩下 2 条，提示里也必须报 2（报 5 而列表只变 2 处，比不报还糟）。
 */
function needsOp(item: MemoryRecord, op: BatchOp): boolean {
  switch (op) {
    case 'permanent':
      return item.level !== 'permanent'
    case 'normal':
      return item.level === 'permanent'
    case 'disable':
      return !item.disabled
    case 'enable':
      return !!item.disabled
    case 'delete':
      return true
  }
}

/** 批量操作的完成文案（`$__failed__` 那条只在真的有失败时才用） */
const BATCH_DONE_TEXT: Record<BatchOp, string> = {
  permanent: '已升级为永久 $__count__ 条记忆',
  normal: '已降级为普通 $__count__ 条记忆',
  disable: '已停用 $__count__ 条记忆',
  enable: '已启用 $__count__ 条记忆',
  delete: '已删除 $__count__ 条记忆',
}

const BATCH_FAIL_TEXT: Record<BatchOp, string> = {
  permanent: '已升级为永久 $__count__ 条记忆，$__failed__ 条失败',
  normal: '已降级为普通 $__count__ 条记忆，$__failed__ 条失败',
  disable: '已停用 $__count__ 条记忆，$__failed__ 条失败',
  enable: '已启用 $__count__ 条记忆，$__failed__ 条失败',
  delete: '已删除 $__count__ 条记忆，$__failed__ 条失败',
}

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
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [section, setSection] = useState<MemoryPromptSection | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  /** 当前选中的记忆 id（批量操作的作用对象） */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => EMPTY_SELECTION)

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
      loadMemorySection(true),
    ])
    setItems(list)
    setRuns(runList)
    setSection(sec)
    // 选中集跟着列表收敛：整理 / 删除 / 别处改了之后，已经不存在的 id 必须掉出去 ——
    // 否则批量栏会显示「已选 3 条」而实际只剩 1 条可操作，计数就是在骗人。
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(list.map((m) => m.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 触发一次整理（`force` = 重跑指定日；默认按「立即整理昨天」） */
  async function handleConsolidate(day: string | null, force: boolean) {
    setBusy(true)
    const report = await consolidateMemories(day, force)
    setBusy(false)
    showToast(reportMessage(report), 3000)
    await reload()
  }

  async function handleSave() {
    if (!draft) return
    if (!draft.summary.trim()) {
      showToast(t('记忆内容不能为空'), 1500)
      return
    }
    await upsertMemory({
      id: draft.id ?? '',
      summary: draft.summary,
      kind: draft.kind,
      level: draft.level,
      disabled: draft.disabled,
      detailKbId: draft.detailKbId ?? null,
      detailDocId: draft.detailDocId ?? null,
    })
    setDraft(null)
    showToast(t('已保存'), 1000)
    await reload()
  }

  async function handleDelete(item: MemoryRecord) {
    const confirmed = await MessageBox.propt(
      t('删除记忆'),
      t('确定删除这条记忆？如有详情正文会一并删除，此操作不可撤销。'),
      { confirmText: t('删除'), cancelText: t('取消'), danger: true },
    )
    if (!confirmed) return
    const removed = await deleteMemory(item.id)
    if (removed) showToast(t('已删除'), 1000)
    await reload()
  }

  async function handleToggleLevel(item: MemoryRecord) {
    const next: MemoryLevel = item.level === 'permanent' ? 'normal' : 'permanent'
    await setMemoryLevel(item.id, next)
    await reload()
  }

  async function handleToggleDisabled(item: MemoryRecord) {
    await setMemoryDisabled(item.id, !item.disabled)
    await reload()
  }

  async function handlePreview() {
    setShowPreview((v) => !v)
  }

  /** 导出 JSON：Rust 给文本，路径由用户选（与「导出会话 Markdown」「导出用量 CSV」同一范式） */
  async function handleExport() {
    const json = await exportMemories()
    if (!json) {
      showToast(t('导出失败（读取记忆失败或不在桌面环境）'), 2500)
      return
    }
    let count = items.length
    try {
      // 条数用文件里的（导出读的是库里的当前状态，可能比面板列表新）
      count = (JSON.parse(json) as MemoryExportFile).count ?? count
    } catch {
      // 解析失败不影响导出本身
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const filePath = await save({
        title: t('导出记忆为 JSON'),
        defaultPath: `virlen-memory-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: t('所有文件'), extensions: ['*'] },
        ],
      })
      if (!filePath) return // 用户取消
      await writeTextFile(filePath, json)
      showToast(tpl('已导出 $__count__ 条记忆', { count }), 2000)
    } catch (e: any) {
      showToast(tpl('导出失败：$__error__', { error: e?.message || String(e) }), 3000)
    }
  }

  const permanent = items.filter((m) => m.level === 'permanent')
  const normal = items.filter((m) => m.level !== 'permanent')
  // 预算告警：被裁过就说明记忆总量已超过注入能力（计数由 Rust 侧给出，前端不自己算）
  const hasBudgetWarning =
    !!section && (section.droppedNormal > 0 || section.droppedPermanent > 0)

  // ==================== 多选与批量操作 ====================
  //
  // 为什么要有它：记忆随蒸馏逐日变多，**清理是常态操作**（注入预算撑满时更是必须动手），
  // 而「一条一条点删除」在这个量级下不可用；反过来，每行常驻 4 个按钮又让列表变成噪音。
  // 于是：行内单条操作只在悬停 / 键盘聚焦时显形，多选走复选框 + 顶部批量栏。

  /** 切换一条的选中态（点整行也能触发，见 `renderItem`） */
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** 一批 id 全选 / 全不选（分区标题的全选框） */
  const setManySelected = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      // 没有变化就返回原对象：重复点「全选」不该白触发一轮重渲染
      return next.size === prev.size ? prev : next
    })
  }, [])

  const clearSelection = useCallback(() => setSelected(EMPTY_SELECTION), [])

  /** 选中的条目里，这个操作**真会改动**的条数（按钮可用性 + 提示里的数字都用它） */
  const batchCount = (op: BatchOp): number =>
    items.filter((m) => selected.has(m.id) && needsOp(m, op)).length

  /**
   * 执行一次批量操作。
   *
   * 只对「确实需要改」的条目下手（`needsOp`）：选中 5 条里 3 条本来就是永久时，「升级为永久」
   * 只该动剩下 2 条 —— 否则提示报 5、用户核对列表只看到 2 处变化，数字与事实不符比不报还糟。
   *
   * 逐条调用既有仓储方法（一条一个 IPC），**单条失败不拖垮整批**，失败条数一并显示。
   * 刻意不加 Rust 批量命令：面板量级（几十条）下这点 IPC 无感，而多一条批量命令就多一套
   * 「部分失败 / 事务语义」口径要维护。
   */
  async function runBatch(op: BatchOp) {
    const targets = items.filter((m) => selected.has(m.id) && needsOp(m, op))
    if (targets.length === 0) return
    if (op === 'delete') {
      const confirmed = await MessageBox.propt(
        t('删除记忆'),
        tpl('确定删除选中的 $__count__ 条记忆？如有详情正文会一并删除，此操作不可撤销。', {
          count: targets.length,
        }),
        { confirmText: t('删除'), cancelText: t('取消'), danger: true },
      )
      if (!confirmed) return
    }
    setBusy(true)
    const results = await Promise.all(
      targets.map(async (m) => {
        try {
          if (op === 'delete') return await deleteMemory(m.id)
          if (op === 'disable') return await setMemoryDisabled(m.id, true)
          if (op === 'enable') return await setMemoryDisabled(m.id, false)
          return await setMemoryLevel(m.id, op)
        } catch {
          return false // 仓储内部已打日志，这里只把它记成「这一条没成功」
        }
      }),
    )
    setBusy(false)
    const ok = results.filter(Boolean).length
    const failed = targets.length - ok
    showToast(
      failed > 0
        ? tpl(BATCH_FAIL_TEXT[op], { count: ok, failed })
        : tpl(BATCH_DONE_TEXT[op], { count: ok }),
      2500,
    )
    // 删掉的 id 已不存在，`reload` 会把选中集收敛到还活着的条目；
    // 级别 / 停用类操作保留选中，方便接着做下一步（例：先停用，再删）
    await reload()
  }

  /** 一个分区（标题带全选框；全选框有**半选态** —— 部分选中不能显示成「全都没选」） */
  function renderSection(title: string, list: MemoryRecord[], emptyText: string) {
    const ids = list.map((m) => m.id)
    const picked = ids.filter((id) => selected.has(id)).length
    const all = picked > 0 && picked === ids.length
    const selectAllLabel = tpl('全选「$__title__」', { title })
    return (
      <div className="memory-section">
        <div className="memory-section-title">
          {list.length > 0 && (
            <input
              type="checkbox"
              className="memory-check"
              checked={all}
              // 半选态只能命令式设置（HTML 没有对应属性）；React 19 的 ref 回调不允许有返回值
              ref={(el) => {
                if (el) el.indeterminate = picked > 0 && !all
              }}
              onChange={(e) => setManySelected(ids, e.target.checked)}
              aria-label={selectAllLabel}
              title={selectAllLabel}
            />
          )}
          <span className="memory-section-name">
            {title} · {list.length}
          </span>
          {picked > 0 && (
            <span className="memory-section-picked">
              {tpl('已选 $__count__ 条', { count: picked })}
            </span>
          )}
        </div>
        <div className="memory-list">
          {list.map(renderItem)}
          {list.length === 0 && <div className="memory-empty">{emptyText}</div>}
        </div>
      </div>
    )
  }

  function renderItem(item: MemoryRecord) {
    const checked = selected.has(item.id)
    return (
      <div
        key={item.id}
        className={`memory-item${checked ? ' is-selected' : ''}${item.disabled ? ' is-off' : ''}`}
        // 点整行也能切换选中：复选框本体只有 15px，长列表里逐条去抠太费手
        onClick={() => toggleSelected(item.id)}>
        <input
          type="checkbox"
          className="memory-check"
          checked={checked}
          aria-label={tpl('选择「$__summary__」', { summary: item.summary })}
          // 行点击已经切过一次，这里必须拦掉冒泡（否则会被切回原状）
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelected(item.id)}
        />
        <div className="memory-item-main">
          <span className="memory-item-summary">{item.summary}</span>
          <div className="memory-item-meta">
            <span className="memory-item-kind">
              {KIND_LABELS[item.kind as MemoryKind] ?? item.kind}
            </span>
            {item.sourceDay && <span className="memory-item-day">{item.sourceDay}</span>}
            <span className="memory-item-hits">
              {tpl('命中 $__count__ 次', { count: item.hits ?? 0 })}
            </span>
            {item.disabled && <span className="memory-item-off">{t('已停用')}</span>}
          </div>
        </div>
        {/* 行内操作：默认隐形，悬停 / 键盘聚焦才显形（见 scss）。
            容器拦掉冒泡，否则点按钮会顺手把这一条选上 */}
        <div className="memory-item-actions" onClick={(e) => e.stopPropagation()}>
          <button className="memory-action-btn" onClick={() => setDraft({
            id: item.id,
            summary: item.summary,
            kind: (item.kind as MemoryKind) ?? 'fact',
            level: (item.level as MemoryLevel) ?? 'normal',
            disabled: !!item.disabled,
            detailKbId: item.detailKbId ?? null,
            detailDocId: item.detailDocId ?? null,
          })}>
            {t('编辑')}
          </button>
          <button className="memory-action-btn" onClick={() => handleToggleLevel(item)}>
            {item.level === 'permanent' ? t('降级为普通') : t('升级为永久')}
          </button>
          <button className="memory-action-btn" onClick={() => handleToggleDisabled(item)}>
            {item.disabled ? t('启用') : t('停用')}
          </button>
          <button className="memory-action-btn danger" onClick={() => handleDelete(item)}>
            {t('删除')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="memory-settings">
      {/* 标题与批量栏同住一块吸顶容器：批量栏必须**在任何滚动位置**都可见 ——
          否则在长列表底部勾选后还要滚回顶部才能操作，多选就失去意义了 */}
      <div className="memory-sticky">
        <div className="memory-header">
          <h2 className="section-title">{t('长期记忆')}</h2>
          <div className="memory-header-actions">
            <button className="memory-action-btn" onClick={() => void handleExport()}>
              {t('导出 JSON')}
            </button>
            <button className="memory-add-btn" onClick={() => setDraft(emptyDraft())}>
              {t('新增记忆')}
            </button>
          </div>
        </div>

        {/* 未选中任何条目时**不渲染**：常态下的列表应该是干净的，批量栏只在多选时存在 */}
        {selected.size > 0 && (
          <div className="memory-batch-bar" role="toolbar" aria-label={t('批量操作')}>
            <span className="memory-batch-count">
              {tpl('已选 $__count__ 条', { count: selected.size })}
            </span>
            <button
              className="memory-action-btn"
              disabled={busy || batchCount('permanent') === 0}
              title={t('选中的都已是永久记忆')}
              onClick={() => void runBatch('permanent')}>
              {t('升级为永久')}
            </button>
            <button
              className="memory-action-btn"
              disabled={busy || batchCount('normal') === 0}
              title={t('选中的本就是普通记忆')}
              onClick={() => void runBatch('normal')}>
              {t('降级为普通')}
            </button>
            <button
              className="memory-action-btn"
              disabled={busy || batchCount('disable') === 0}
              title={t('选中的都已停用')}
              onClick={() => void runBatch('disable')}>
              {t('停用')}
            </button>
            <button
              className="memory-action-btn"
              disabled={busy || batchCount('enable') === 0}
              title={t('选中的都未停用')}
              onClick={() => void runBatch('enable')}>
              {t('启用')}
            </button>
            <button
              className="memory-action-btn danger"
              disabled={busy}
              onClick={() => void runBatch('delete')}>
              {t('删除')}
            </button>
            <button
              className="memory-action-btn memory-batch-clear"
              onClick={clearSelection}>
              {t('取消选择')}
            </button>
          </div>
        )}
      </div>

      <p className="memory-hint">
        {t('记忆会在新建会话时注入系统提示词：永久记忆全量注入，普通记忆按命中次数与时间取前 20 条。')}
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
        <button className="memory-action-btn" onClick={handlePreview}>
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

      {showPreview && section && (
        <div className="memory-preview">
          <div className="memory-preview-title">{t('注入预览')}</div>
          <pre className="memory-preview-body">
            {section.text || t('（当前没有可注入的记忆）')}
          </pre>
        </div>
      )}

      {draft && (
        <div className="memory-form">
          <div className="memory-form-title">
            {draft.id ? t('编辑记忆') : t('新增记忆')}
          </div>
          <textarea
            className="memory-form-summary"
            value={draft.summary}
            maxLength={MEMORY_SUMMARY_MAX_CHARS}
            placeholder={t('记忆内容')}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          />
          <div className="memory-form-hint">
            {tpl('建议不超过 $__hint__ 字符，最多 $__max__ 字符（超出会被截断）', {
              hint: MEMORY_SUMMARY_HINT_CHARS,
              max: MEMORY_SUMMARY_MAX_CHARS,
            })}
          </div>
          <div className="memory-form-row">
            <label>
              <span>{t('分类')}</span>
              {/* 走共享 `Select` 而不是原生 <select>：下拉面板 Portal 到 body，不会被设置页的
                  滚动容器裁剪，视觉 / 键位也与其它设置页一致 */}
              <Select
                value={draft.kind}
                onChange={(v) => setDraft({ ...draft, kind: v as MemoryKind })}
                options={KIND_OPTIONS}
                width={120}
              />
            </label>
            <label>
              <span>{t('级别')}</span>
              <Select
                value={draft.level}
                onChange={(v) => setDraft({ ...draft, level: v as MemoryLevel })}
                options={LEVEL_OPTIONS}
                width={120}
              />
            </label>
            <button className="memory-action-btn primary" onClick={handleSave}>
              {t('保存')}
            </button>
            <button className="memory-action-btn" onClick={() => setDraft(null)}>
              {t('取消')}
            </button>
          </div>
        </div>
      )}

      {renderSection(t('永久记忆'), permanent, t('暂无永久记忆'))}

      {renderSection(t('普通记忆'), normal, t('暂无普通记忆'))}

      {loading && <div className="memory-empty">{t('加载中…')}</div>}
    </div>
  )
}

export default observer(MemorySettings)
