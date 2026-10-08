/**
 * MemoryListModal — 长期记忆列表弹窗（记忆功能 P0 / P3）
 *
 * 紧凑表格：每行一条（内容列小字号 + 悬停看全文），上方两行工具栏（搜索 / 计数 / 导出 / 新增；
 * 左筛选、右批量），下方分页。目标就一个：**一屏尽量多看几条** —— 用户来这儿多半是
 * 「扫一眼 + 清理一批」，不是逐条精读。
 *
 * 故行内不挂任何操作按钮：**点击整行 = 编辑**（`MemoryEditModal`），**勾选 + 批量栏 =
 * 升级 / 降级 / 停用 / 删除**。批量栏**常驻**（未选中时全禁用），勾选时不会有东西冒出来
 * 把表格上下顶动，也让人一眼看到「选中之后能做什么」。
 *
 * 筛选在前端做（不调 `cmd_memory_search`）：后端检索**排除已停用项**，而列表必须能筛出
 * 停用项才能管理它们；面板量级（几百条）下本地子串过滤是即时的。分页也在前端（列表本就
 * 整份在内存里），表头全选只作用于**本页**（避免「以为只选一屏，实际选了 200 条」），
 * 选中集跨页保留，批量栏如实报出有多少条不在当前页。
 *
 * 数据由父级持有，写操作后统一走 `onChanged` 让父级重取 —— 设置页的预算告警才是当前状态。
 */
import { useEffect, useMemo, useState } from 'react'
import Modal from '@/ui/components/shared/Modal'
import Select, { type SelectOption } from '@/ui/components/shared/Select'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { t, tpl } from '@/ui/i18n'
import { rowKeyHandler } from '@/utils/a11y'
import {
  deleteMemory,
  exportMemories,
  setMemoryDisabled,
  setMemoryLevel,
} from '@/infrastructure/memoryRepo'
import {
  MEMORY_KIND_PROJECT,
  type MemoryExportFile,
  type MemoryRecord,
} from '@/domain/memory'
import { formatMemoryDay, memoryDateTitle } from './format'
import { FILTER_ALL, kindLabel, kindOptions, levelLabel, levelOptions } from './labels'
import MemoryEditModal from './MemoryEditModal'

export interface MemoryListModalProps {
  visible: boolean
  onClose: () => void
  /** 当前记忆列表（父级持有，勿在本组件里另取一份 —— 两份数据必然分叉） */
  items: MemoryRecord[]
  loading: boolean
  /** 写操作后通知父级：重取列表 + 注入段 + 整理流水 */
  onChanged: () => void | Promise<void>
}

/** 默认每页条数；一屏 20 行是「扫一眼」的舒适密度 */
const PAGE_SIZE_DEFAULT = 20

/** 每页条数选项（纯数字，无需 i18n） */
const PAGE_SIZE_OPTIONS: SelectOption[] = [20, 50, 100].map((n) => ({
  value: n,
  label: String(n),
}))

/** 共享的空选中集（**只读**：每次改动都新建一份，绝不原地改） */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>()

/** 批量操作种类（与单条同语义，只是作用在一批上） */
type BatchOp = 'permanent' | 'normal' | 'disable' | 'enable' | 'delete'

/**
 * 这个操作会不会**真的改动**这条记忆：批量栏按钮可用性、提示里的条数都用它 ——
 * 选中 5 条里 3 条本来就是永久时，「升级为永久」只该动剩下 2 条，提示也必须报 2
 * （报 5 而列表只变 2 处，比不报还糟）。
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

/** 完成文案（`$__failed__` 只在真有失败时才用） */
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

function MemoryListModal({
  visible,
  onClose,
  items,
  loading,
  onChanged,
}: MemoryListModalProps) {
  const [busy, setBusy] = useState(false)
  /** 内容模糊搜索（本地子串，大小写不敏感） */
  const [query, setQuery] = useState('')
  /** 级别（`all` = 不筛） */
  const [levelFilter, setLevelFilter] = useState<'all' | 'permanent' | 'normal'>(FILTER_ALL)
  /** 分类（`all` = 不筛）；与级别是两个独立维度，可叠加 */
  const [kindFilter, setKindFilter] = useState<string>(FILTER_ALL)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)
  /** 选中的记忆 id（批量操作作用对象，跨页保留） */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => EMPTY_SELECTION)
  /** 编辑子弹窗：target 为 `null` = 新增 */
  const [editOpen, setEditOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<MemoryRecord | null>(null)

  // 关闭时清掉所有临时视图状态：下次打开回到「全量、第 1 页、无选中、无表单」，
  // 而不是带着上次的搜索词与半截勾选回来（那会让人以为是数据变了）
  useEffect(() => {
    if (visible) return
    setSelected(EMPTY_SELECTION)
    setEditOpen(false)
    setEditTarget(null)
    setQuery('')
    setLevelFilter(FILTER_ALL)
    setKindFilter(FILTER_ALL)
    setPage(1)
    setPageSize(PAGE_SIZE_DEFAULT)
  }, [visible])

  // 列表变了（整理产出 / 删除 / 别处改动）后选中集必须收敛：已不存在的 id 要掉出去，
  // 否则批量栏显示「已选 3 条」而实际只剩 1 条可操作 —— 计数就是在骗人。
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(items.map((m) => m.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  /**
   * 筛选下拉在渲染时建（语言切换后重建一次即可，不必进 state）。
   * `true` = 带「全部」那条，筛选栏才有「不筛」的出口（编辑表单不能带，见 `labels.ts`）。
   */
  const levelFilterOptions: SelectOption[] = levelOptions(true)
  const kindFilterOptions: SelectOption[] = kindOptions(true)

  /**
   * 筛选结果（顺序沿用后端：永久在前 → 新建在前）。
   * 三个条件是**叠加**：分类 ∧ 级别 ∧ 内容子串，任一不匹配就出局（不是「任一命中」）。
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((m) => {
      if (kindFilter !== FILTER_ALL && m.kind !== kindFilter) return false
      if (
        levelFilter !== FILTER_ALL &&
        (m.level === 'permanent' ? 'permanent' : 'normal') !== levelFilter
      ) {
        return false
      }
      if (!q) return true
      return (m.summary ?? '').toLowerCase().includes(q)
    })
  }, [items, query, kindFilter, levelFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  // 夹一下而不是纠 state：筛选后条数变少时不该多渲染一帧「空白页」
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const pageIds = pageRows.map((m) => m.id)

  /**
   * 选中集里有多少条**不在当前页**（被筛掉的与在其它页的都算）。
   * 必须如实报出来，否则「已选 20 条 → 删除」会删掉一片看不见的条目。
   */
  const selectedOffPage = selected.size - pageIds.filter((id) => selected.has(id)).length

  async function handleExport() {
    const json = await exportMemories()
    if (!json) {
      showToast(t('导出失败：读不到记忆数据'), 2500)
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
        title: t('导出记忆备份'),
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

  /** 只由复选框触发 —— 点整行是「编辑」，别让两个动作抢同一次点击 */
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 只作用于**本页**（半选态由 `indeterminate` 画） */
  function togglePage(rows: MemoryRecord[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const m of rows) {
        if (on) next.add(m.id)
        else next.delete(m.id)
      }
      return next.size === prev.size ? prev : next
    })
  }

  /** 选中里这个操作**真会改动**的条数（按钮可用性 + 提示数字都用它） */
  const batchCount = (op: BatchOp): number =>
    items.filter((m) => selected.has(m.id) && needsOp(m, op)).length

  /**
   * 批量按钮的禁用原因提示：没勾选时必须说清**怎么开始**，否则一排灰按钮看着就像坏了；
   * 能点时不给 tip —— 浮层会挡视线。
   */
  function batchTip(op: BatchOp, already: string): string | undefined {
    if (selected.size === 0) return t('先勾选要操作的记忆')
    return batchCount(op) === 0 ? already : undefined
  }

  /**
   * 逐条调既有仓储方法（一条一个 IPC），**单条失败不拖垮整批**，失败条数一并显示。
   * 刻意不加 Rust 批量命令：面板量级（几十条）下这点 IPC 无感，而多一条批量命令就多一套
   * 「部分失败 / 事务语义」口径要维护。
   */
  async function runBatch(op: BatchOp) {
    const targets = items.filter((m) => selected.has(m.id) && needsOp(m, op))
    if (targets.length === 0) return
    if (op === 'delete') {
      const confirmed = await MessageBox.propt(
        t('删除记忆'),
        tpl('删除选中的 $__count__ 条记忆？存进知识库的长内容也会一起删掉，无法恢复。', {
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
    // 删掉的 id 已不存在，列表收敛会修好选中集；级别 / 停用类保留选中，方便接着做下一步
    await onChanged()
  }

  /** 打开编辑子弹窗（点整行 / 键盘 Enter） */
  function openEdit(item: MemoryRecord | null) {
    setEditTarget(item)
    setEditOpen(true)
  }

  const pickedOnPage = pageIds.filter((id) => selected.has(id)).length
  const allOnPage = pageRows.length > 0 && pickedOnPage === pageRows.length

  /** 一行一条（单元格只读；动作走「点行编辑」与「勾选 + 批量栏」） */
  function renderRow(item: MemoryRecord) {
    const day = formatMemoryDay(item.createdAt)
    return (
      <tr
        key={item.id}
        className={`${selected.has(item.id) ? 'is-selected' : ''}${item.disabled ? ' is-off' : ''}`.trim()}
        // 点整行 = 编辑：行内已无按钮，且这是最高频的单条动作
        onClick={() => openEdit(item)}
        // 键盘可达：整行可聚焦，Enter / Space 等同点击（WCAG 2.1.1）
        tabIndex={0}
        onKeyDown={rowKeyHandler(() => openEdit(item))}
        title={t('点击编辑这条记忆')}>
        <td className="memory-cell-check">
          <input
            type="checkbox"
            className="memory-check"
            checked={selected.has(item.id)}
            aria-label={tpl('选择「$__summary__」', { summary: item.summary })}
            // 行点击已绑「编辑」：这里必须拦掉冒泡，否则勾选会顺手打开编辑弹窗
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelected(item.id)}
          />
        </td>
        {/* 小字号 + 单行省略，悬停看全文 */}
        <td className="memory-cell-summary" title={item.summary}>
          {item.summary}
        </td>
        <td className="memory-cell-kind">{kindLabel(item.kind)}</td>
        {/* 项目路径决定这条记忆在哪些会话可见；没限路径的项目记忆要明说「所有项目」，不能留空白 */}
        <td className="memory-cell-project" title={item.projectPath || undefined}>
          {item.projectPath || (item.kind === MEMORY_KIND_PROJECT ? t('所有项目') : '')}
        </td>
        <td className="memory-cell-level">{levelLabel(item.level)}</td>
        <td className="memory-cell-date" title={memoryDateTitle(item)}>
          {day || '—'}
        </td>
        <td className="memory-cell-source">{item.sourceDay || '—'}</td>
        <td className="memory-cell-hits">{item.hits ?? 0}</td>
        <td className="memory-cell-state">{item.disabled ? t('已停用') : ''}</td>
      </tr>
    )
  }

  return (
    <>
      <Modal
        visible={visible}
        title={t('全部记忆')}
        onClose={onClose}
        width={920}
        height={640}
        className="memory-list-modal"
        footer={
          filtered.length > 0 && (
            <div className="memory-pager">
              <span className="memory-pager-info">
                {filtered.length === items.length
                  ? tpl('共 $__count__ 条', { count: items.length })
                  : tpl('筛选出 $__shown__ 条 / 共 $__total__ 条', {
                      shown: filtered.length,
                      total: items.length,
                    })}
              </span>
              <div className="memory-pager-actions">
                <span className="memory-pager-size">
                  {t('每页')}
                  <Select
                    value={pageSize}
                    onChange={(v) => {
                      setPageSize(Number(v))
                      setPage(1)
                    }}
                    options={PAGE_SIZE_OPTIONS}
                    width={78}
                  />
                </span>
                <button
                  className="memory-action-btn"
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}>
                  {t('上一页')}
                </button>
                <span className="memory-pager-page">
                  {safePage} / {pageCount}
                </span>
                <button
                  className="memory-action-btn"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage(safePage + 1)}>
                  {t('下一页')}
                </button>
              </div>
            </div>
          )
        }>
        {/* 工具栏与表格滚动区分开：两行工具栏常驻不滚，表头在滚动区里自己吸顶 */}
        <div className="memory-toolbar">
          <div className="memory-filter-row">
            <input
              className="memory-search"
              type="search"
              value={query}
              placeholder={t('搜索记忆内容…')}
              aria-label={t('搜索记忆内容')}
              onChange={(e) => {
                setQuery(e.target.value)
                // 换筛选就回第 1 页，否则会停在越界页上（看起来像「空了」）
                setPage(1)
              }}
            />
            <span className="memory-count">
              {filtered.length === items.length
                ? tpl('共 $__count__ 条', { count: items.length })
                : tpl('筛选出 $__shown__ 条 / 共 $__total__ 条', {
                    shown: filtered.length,
                    total: items.length,
                  })}
            </span>
            <div className="memory-toolbar-actions">
              <button className="memory-action-btn" onClick={() => void handleExport()}>
                {t('导出备份')}
              </button>
              <button className="memory-add-btn" onClick={() => openEdit(null)}>
                {t('新增记忆')}
              </button>
            </div>
          </div>

          {/* 第二行：左筛选、右批量。批量栏**常驻**而非「选中才出现」：出现 / 消失会把表格
              顶动一次，视线得重新找位置；左边管「看哪些」，右边管「动哪些」，位置固定才不混。 */}
          <div className="memory-action-row">
            <div className="memory-filter-selects">
              <span className="memory-filter-label">{t('分类')}</span>
              <Select
                className="memory-filter-kind"
                value={kindFilter}
                onChange={(v) => {
                  setKindFilter(v as string)
                  setPage(1)
                }}
                options={kindFilterOptions}
                width={104}
              />
              <span className="memory-filter-label">{t('级别')}</span>
              <Select
                className="memory-filter-level"
                value={levelFilter}
                onChange={(v) => {
                  setLevelFilter(v as 'all' | 'permanent' | 'normal')
                  setPage(1)
                }}
                options={levelFilterOptions}
                width={92}
              />
            </div>
            <div
              className={`memory-batch-bar${selected.size > 0 ? ' is-active' : ''}`}
              role="toolbar"
              aria-label={t('批量操作')}>
              <span className="memory-batch-count">
                {tpl('已选 $__count__ 条', { count: selected.size })}
                {/* 跨页保留：如实报出不在当前页的条数，否则批量删除会悄悄删掉看不见的 */}
                {selectedOffPage > 0 &&
                  tpl('（其中 $__hidden__ 条不在当前页）', { hidden: selectedOffPage })}
              </span>
              <button
                className="memory-action-btn"
                disabled={busy || batchCount('permanent') === 0}
                title={batchTip('permanent', t('选中的都已是永久记忆'))}
                onClick={() => void runBatch('permanent')}>
                {t('升级为永久')}
              </button>
              <button
                className="memory-action-btn"
                disabled={busy || batchCount('normal') === 0}
                title={batchTip('normal', t('选中的本就是普通记忆'))}
                onClick={() => void runBatch('normal')}>
                {t('降级为普通')}
              </button>
              <button
                className="memory-action-btn"
                disabled={busy || batchCount('disable') === 0}
                title={batchTip('disable', t('选中的都已停用'))}
                onClick={() => void runBatch('disable')}>
                {t('停用')}
              </button>
              <button
                className="memory-action-btn"
                disabled={busy || batchCount('enable') === 0}
                title={batchTip('enable', t('选中的都未停用'))}
                onClick={() => void runBatch('enable')}>
                {t('启用')}
              </button>
              {/* 删除是破坏性动作：没勾选时禁掉（否则点下去只会弹一个「删 0 条」的确认框） */}
              <button
                className="memory-action-btn danger"
                disabled={busy || selected.size === 0}
                title={selected.size === 0 ? t('先勾选要操作的记忆') : undefined}
                onClick={() => void runBatch('delete')}>
                {t('删除')}
              </button>
              <button
                className="memory-action-btn memory-batch-clear"
                disabled={busy || selected.size === 0}
                onClick={() => setSelected(EMPTY_SELECTION)}>
                {t('取消选择')}
              </button>
            </div>
          </div>

          <p className="memory-list-hint">
            {t('点一行就能改内容；要停用或删除，先勾选，再用右边的批量操作。')}
          </p>
        </div>

        <div className="memory-table-wrap">
          <table className="memory-table">
            <colgroup>
              <col className="memory-col-check" />
              <col />
              <col className="memory-col-kind" />
              <col className="memory-col-project" />
              <col className="memory-col-level" />
              <col className="memory-col-date" />
              <col className="memory-col-source" />
              <col className="memory-col-hits" />
              <col className="memory-col-state" />
            </colgroup>
            <thead>
              <tr>
                <th>
                  {/* 全选只作用本页，逐页确认，避免「以为只选了一屏」 */}
                  <input
                    type="checkbox"
                    className="memory-check"
                    checked={allOnPage}
                    ref={(el) => {
                      if (el) el.indeterminate = pickedOnPage > 0 && !allOnPage
                    }}
                    onChange={(e) => togglePage(pageRows, e.target.checked)}
                    aria-label={tpl('全选本页 $__count__ 条', { count: pageRows.length })}
                    title={tpl('全选本页 $__count__ 条', { count: pageRows.length })}
                  />
                </th>
                <th>{t('内容')}</th>
                <th>{t('分类')}</th>
                <th>{t('项目')}</th>
                <th>{t('级别')}</th>
                <th>{t('记录')}</th>
                <th>{t('来源')}</th>
                <th>{t('使用次数')}</th>
                <th>{t('状态')}</th>
              </tr>
            </thead>
            <tbody>{pageRows.map(renderRow)}</tbody>
          </table>

          {pageRows.length === 0 && (
            <div className="memory-empty">
              {/* 顺序要紧：首次加载时 `loading` 与「没有记忆」长得一样，先判 loading，
                  否则会闪一句「还没有任何记忆」吓人 */}
              {loading && items.length === 0
                ? t('加载中…')
                : items.length === 0
                  ? t('还没有记忆 —— 你可以自己加一条，也可以在对话里直接告诉 AI 什么值得记住')
                  : t('没有匹配的记忆（试试清空搜索或筛选）')}
            </div>
          )}
        </div>
      </Modal>

      {/* 编辑 / 新增子弹窗 */}
      <MemoryEditModal
        visible={editOpen}
        item={editTarget}
        onClose={() => setEditOpen(false)}
        onSaved={onChanged}
      />
    </>
  )
}

export default MemoryListModal
