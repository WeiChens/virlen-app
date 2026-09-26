/**
 * security-sandbox-rules — 安全菜单 · 「忽略沙盒命令」Tab
 *
 * 维护一组「命中即强制以『不使用沙盒』方式执行」的命令规则：沙盒开启时，命中规则的命令免去「沙盒脱壳」
 * 授权，并被引擎直接改为无沙盒执行（AI 不必显式传 `sandbox:"off"`）。匹配逻辑只有一份，在
 * `@/domain/security/sandbox-ignore-rules`；Rust 与 CLI 的判定在 `virlen-core/src/security/`
 *（同一份 golden 契约收敛）。
 *
 * ⚠️ 规则只免除「沙盒脱壳」授权：命令本身的风险审批（终端正常/安装/危险命令、脚本执行）仍按「权限
 * 管理」里的三态设置走；`deny` 与只读沙盒不受规则影响。
 *
 * 列表顺序即优先级：从上到下取第一条命中的启用规则，故列表提供上移 / 下移。
 */
import { useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { securityStore } from '@/ui/store/securityStore'
import Modal from '@/ui/components/shared/Modal'
import CodeEditor from '@/ui/components/code-editor/CodeEditor'
import AddSvg from '@/ui/components/icons/AddSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import EditSvg from '@/ui/components/icons/EditSvg'
import DragSvg from '@/ui/components/icons/DragSvg'
import Toggle from '@/ui/components/shared/Toggle'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import {
  compileSandboxRule,
  createSandboxIgnoreRule,
  createSandboxIgnoreRuleFromPreset,
  defaultSandboxRulePattern,
  SANDBOX_JS_DEFAULT_PATTERN,
  SANDBOX_RULE_PRESETS,
  testSandboxRule,
  type SandboxIgnoreRule,
  type SandboxRuleKind,
  type SandboxRulePreset,
  type SandboxRuleTestResult,
  type SandboxTextMode,
} from '@/domain/security/sandbox-ignore-rules'
import { t, tpl } from '@/ui/i18n'
import {
  computeDropIndex,
  dropIndicatorTop,
  type RowRange,
} from './sandbox-rules-dnd'
import './security-sandbox-rules.scss'

/** 规则类型 / 文本比较方式的中文标签（中文即 i18n key） */
const KIND_LABELS: Record<SandboxRuleKind, string> = {
  text: '文本匹配',
  regex: '正则匹配',
  js: 'JS 脚本匹配',
}

const TEXT_MODE_LABELS: Record<SandboxTextMode, string> = {
  exact: '完全匹配',
  prefix: '前缀匹配',
  suffix: '后缀匹配',
}

/**
 * 列表徽标用的短标签。
 *
 * 列表行可用宽度只有 ~450px：按全称渲染「文本匹配 + 前缀匹配 + 区分大小写」三个徽标时，
 * 规则名会被挤到只剩两三个字。列表里合并成一个「文本 · 前缀」徽标，
 * 完整选项名只在空间充足的编辑弹窗出现。
 */
const KIND_SHORT_LABELS: Record<SandboxRuleKind, string> = {
  text: '文本',
  regex: '正则',
  js: 'JS',
}

const TEXT_MODE_SHORT_LABELS: Record<SandboxTextMode, string> = {
  exact: '完全',
  prefix: '前缀',
  suffix: '后缀',
}

/**
 * 列表徽标文案：文本规则带上比较方式（如「文本 · 前缀」），其余只显示类型。
 *
 * 拼成一个字符串再渲染（而不是相邻文本节点）—— SSR / 测试拿到的 markup 更干净。
 */
function kindBadgeLabel(rule: SandboxIgnoreRule): string {
  const kind = t(KIND_SHORT_LABELS[rule.kind])
  if (rule.kind !== 'text') return kind
  const mode =
    TEXT_MODE_SHORT_LABELS[rule.textMode] ?? TEXT_MODE_SHORT_LABELS.exact
  return `${kind} · ${t(mode)}`
}

/** 位移死区：小于它仍按点击处理（与 `chat/.../use-tree-drag.ts` 同一定值） */
const DRAG_THRESHOLD = 4

/**
 * 拖拽会话（不参与渲染的部分）。
 *
 * 行几何在按下时测一次就缓存：行高不固定（匹配内容是 1~2 行裁剪），
 * 拖拽期间又禁止滚动，所以缓存值整个会话都有效。
 */
interface DragSession {
  id: string
  pointerId: number
  startClientY: number
  /** 列表容器的 rect.top 与 scrollTop（把指针坐标换算到内容坐标系） */
  listTop: number
  scrollTop: number
  rows: RowRange[]
  /** 是否已越过死区（点一下不应算拖拽） */
  moved: boolean
  /** 当前落点间隙（0..n） */
  to: number
}

/** 拖拽中需要渲染的部分 */
interface DragVisual {
  /** 被拖行的 id（加 is-dragging 与 transform 用） */
  id: string
  /** 跟随指针的纵向位移 */
  dy: number
  /** 落点间隙 */
  to: number
  /** 行几何（算指示线位置） */
  rows: RowRange[]
}

const SandboxIgnoreRules = observer(function SandboxIgnoreRules() {
  const rules = securityStore.sandboxIgnoreRules
  /** 弹窗草稿：null = 关闭；isNew 决定标题与保存后的行为 */
  const [draft, setDraft] = useState<SandboxIgnoreRule | null>(null)
  const [isNew, setIsNew] = useState(false)
  /** 试跑用的样例命令与结果 */
  const [sample, setSample] = useState('')
  const [testResult, setTestResult] = useState<SandboxRuleTestResult | null>(
    null,
  )
  /** 规则列表容器：拖拽排序要相对它测量行位置 / 算指示线 */
  const listRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const [drag, setDrag] = useState<DragVisual | null>(null)

  const KIND_OPTIONS: { value: SandboxRuleKind; label: string }[] = [
    { value: 'text', label: t(KIND_LABELS.text) },
    { value: 'regex', label: t(KIND_LABELS.regex) },
    { value: 'js', label: t(KIND_LABELS.js) },
  ]
  const TEXT_MODE_OPTIONS: { value: SandboxTextMode; label: string }[] = [
    { value: 'exact', label: t(TEXT_MODE_LABELS.exact) },
    { value: 'prefix', label: t(TEXT_MODE_LABELS.prefix) },
    { value: 'suffix', label: t(TEXT_MODE_LABELS.suffix) },
  ]

  function openCreate() {
    setDraft(createSandboxIgnoreRule())
    setIsNew(true)
    setSample('')
    setTestResult(null)
  }

  function openEdit(rule: SandboxIgnoreRule) {
    setDraft({ ...rule })
    setIsNew(false)
    setSample('')
    setTestResult(null)
  }

  /** 空列表里的「常用规则」：按预设建一条并直接打开弹窗，让用户过一眼再保存 */
  function addFromPreset(preset: SandboxRulePreset) {
    setDraft(createSandboxIgnoreRuleFromPreset(preset))
    setIsNew(true)
    setSample('')
    setTestResult(null)
  }

  /**
   * 删除规则：必须二次确认。
   *
   * 被删的可能是一条写了十几行的 JS 规则，而设置项没有草稿 / 撤销 / 回溯，
   * 误点一下内容就永久丢了 —— 与「打开编辑器」等其它设置页保持同一套危险操作口径。
   */
  async function removeRule(rule: SandboxIgnoreRule) {
    const ok = await MessageBox.warn(
      t('删除规则'),
      tpl('确定要删除规则「$__name__」吗？此操作无法撤销', {
        name: rule.name || t('未命名规则'),
      }),
    )
    if (!ok) return
    securityStore.removeSandboxRule(rule.id)
  }

  /**
   * 开始拖拽排序。
   *
   * 用 **pointer 事件**而不是 HTML5 drag & drop：窗口开了原生拖放（`dragDropEnabled: true`，
   * AGENTS §11.8），页面收不到 drop / dragover —— 与 `chat/.../use-tree-drag.ts` 同一原因。
   * 与那份实现的差别：规则列表通常只有几条（不是虚拟列表），
   * 拖动过程直接走 React state 渲染（被拖行 transform + 落点指示线），不做 DOM 直改。
   */
  function handleGripPointerDown(
    e: React.PointerEvent<HTMLElement>,
    id: string,
    index: number,
  ) {
    if (e.button !== 0) return // 只响应主键（右 / 中键不拖）
    const list = listRef.current
    if (!list) return
    const listRect = list.getBoundingClientRect()
    const rows: RowRange[] = Array.from(
      list.querySelectorAll<HTMLElement>('.rule-item'),
    ).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        top: r.top - listRect.top + list.scrollTop,
        bottom: r.bottom - listRect.top + list.scrollTop,
      }
    })
    sessionRef.current = {
      id,
      pointerId: e.pointerId,
      startClientY: e.clientY,
      listTop: listRect.top,
      scrollTop: list.scrollTop,
      rows,
      moved: false,
      to: index,
    }
    // 指针捕获：指针移出把手（甚至移出列表）后仍能收到 move / up
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handleGripPointerMove(e: React.PointerEvent<HTMLElement>) {
    const s = sessionRef.current
    if (!s || e.pointerId !== s.pointerId) return
    const dy = e.clientY - s.startClientY
    if (!s.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return
      s.moved = true
    }
    // 统一换算到「列表内容坐标系」（与按下时测量的 rows 同一套）
    s.to = computeDropIndex(s.rows, e.clientY - s.listTop + s.scrollTop)
    setDrag({ id: s.id, dy, to: s.to, rows: s.rows })
  }

  /** 松手：越过死区才真正重排（原地不动时由领域函数自动跳过落库） */
  function handleGripPointerUp(e: React.PointerEvent<HTMLElement>) {
    const s = sessionRef.current
    if (!s || e.pointerId !== s.pointerId) return
    sessionRef.current = null
    setDrag(null)
    if (!s.moved) return
    securityStore.reorderSandboxRule(s.id, s.to)
  }

  /** 拖拽被系统中断（如触摸手势被接管）：只复位，不重排 */
  function handleGripPointerCancel(e: React.PointerEvent<HTMLElement>) {
    const s = sessionRef.current
    if (!s || e.pointerId !== s.pointerId) return
    sessionRef.current = null
    setDrag(null)
  }

  /** 键盘等价操作：方向键上移 / 下移一位（拖拽不能是唯一的排序途径） */
  function handleGripKeyDown(e: React.KeyboardEvent<HTMLElement>, id: string) {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      securityStore.moveSandboxRule(id, -1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      securityStore.moveSandboxRule(id, 1)
    }
  }

  /** 把 JS 规则内容恢复成默认模板（会覆盖已写内容，先确认） */
  async function resetJsPattern() {
    if (!draft || draft.kind !== 'js') return
    const ok = await MessageBox.warn(
      t('重置为默认模板'),
      t('确定要重置为默认模板吗？当前内容将被覆盖'),
    )
    if (!ok) return
    update({ pattern: SANDBOX_JS_DEFAULT_PATTERN })
  }

  function close() {
    setDraft(null)
    setTestResult(null)
  }

  function update(patch: Partial<SandboxIgnoreRule>) {
    setDraft((d) => (d ? { ...d, ...patch } : d))
    // 内容变了 → 清掉上一次试跑结果，避免误读旧结论
    setTestResult(null)
  }

  /**
   * 切换匹配方式：**匹配内容回归该方式的默认值**。
   *
   * 文本 / 正则的写法塞进 JS 规则（反之亦然）只会得到一条永远报错或永远不命中的规则，
   * 与其让用户自己清空，不如切换时直接换成新方式的起点（JS 预填带注释的函数模板）。
   * 点当前已选中的方式不重置，避免手滑清掉已写好的内容；
   * 「比较方式」（完全 / 前缀 / 后缀）只改变比较口径，不动匹配内容。
   */
  function changeKind(kind: SandboxRuleKind) {
    if (!draft || draft.kind === kind) return
    update({ kind, pattern: defaultSandboxRulePattern(kind) })
  }

  function runTest() {
    if (!draft) return
    setTestResult(testSandboxRule(draft, sample))
  }

  function save() {
    if (!draft) return
    if (!draft.name.trim()) {
      showToast(t('规则名称不能为空'))
      return
    }
    if (!draft.pattern.trim()) {
      showToast(t('匹配内容不能为空'))
      return
    }
    // 只校验能否「编译」（正则非法 / JS 语法错误）：规则体**不执行** ——
    // 运行期报错在生产里按「未命中」处理，不应拦住保存（见 compileSandboxRule）
    const compileError = compileSandboxRule(draft)
    if (compileError) {
      showToast(
        tpl('规则内容无法编译：$__error__', { error: compileError }),
      )
      return
    }
    securityStore.upsertSandboxRule({ ...draft, name: draft.name.trim() })
    close()
  }

  // JS 规则的输入框是代码编辑器（默认模板已预填），只有文本 / 正则需要占位符
  const patternPlaceholder =
    draft?.kind === 'text'
      ? draft.textMode === 'exact'
        ? t('整条命令，例如：npm install')
        : draft.textMode === 'prefix'
          ? t('命令开头，例如：npm')
          : t('命令结尾，例如：--version')
      : t('正则源码，例如：^npm (run )?(install|test)\\b')

  /** 名称与匹配内容都非空才允许保存（置灰 + title 说明原因，比点完只弹 toast 更早一步） */
  const canSave = !!draft && !!draft.name.trim() && !!draft.pattern.trim()

  return (
    <div className="sandbox-ignore-rules">
      <h2 className="section-title">{t('忽略沙盒命令')}</h2>

      <div className="section-desc">
        <span className="t">
          {t(
            '命中下面规则的命令会自动以「不使用沙盒」方式执行：不再要求授权，AI 也不必显式申请 sandbox:"off"。适合 vitest / vite / node-gyp 等需要管道 stdio、在沙盒下必然失败的命令。',
          )}
        </span>
        <br />
        {t(
          '规则只免除「沙盒脱壳」授权（并把该命令改为「不使用沙盒」执行）；命令本身的审批仍按「权限管理」的设置执行（如终端安装命令设为「询问」时仍会询问一次）。「沙盒脱壳」权限设为「禁止」或沙盒处于只读模式时，规则不生效。',
        )}
      </div>

      <div className="rules-toolbar">
        <button className="rule-add-btn" onClick={openCreate}>
          <AddSvg fill="currentColor" />
          <span>{t('新增规则')}</span>
        </button>
        <span className="rules-count">
          {tpl('共 $__count__ 条规则（$__enabled__ 条已启用）', {
            count: rules.length,
            enabled: rules.filter((r) => r.enabled).length,
          })}
        </span>
        {/* 只有一条规则时无所谓优先级，不占位置 */}
        {rules.length > 1 && (
          <span className="rules-order-hint">
            {t('拖动左侧把手调整优先级；从上到下依次匹配，越靠上优先级越高')}
          </span>
        )}
      </div>

      {rules.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">{t('还没有规则')}</p>
          <p className="empty-desc">
            {t(
              '配好规则后，AI 执行安装 / 测试这类命令时会自动以「不使用沙盒」方式执行，不必每次申请脱壳授权。',
            )}
          </p>
          <div className="empty-presets">
            <span className="presets-label">{t('常用规则（点击添加）')}</span>
            <div className="preset-list">
              {SANDBOX_RULE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  className="preset-chip"
                  title={preset.pattern}
                  onClick={() => addFromPreset(preset)}>
                  <AddSvg fill="currentColor" />
                  <span>{t(preset.name)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`rule-list${drag ? ' is-dragging' : ''}`}
          ref={listRef}>
          {/* 落点指示线：插到哪个间隙，比高亮整行更精确 */}
          {drag && (
            <div
              className="rule-drop-line"
              style={{ top: dropIndicatorTop(drag.rows, drag.to) }}
              aria-hidden="true"
            />
          )}
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              className={`rule-item${rule.enabled ? '' : ' is-disabled'}${
                drag?.id === rule.id ? ' is-dragging' : ''
              }`}
              style={
                drag?.id === rule.id
                  ? { transform: `translateY(${drag.dy}px)` }
                  : undefined
              }>
              {rules.length > 1 ? (
                <span
                  className="rule-grip"
                  role="button"
                  tabIndex={0}
                  aria-label={t('拖动排序（或用上下方向键）')}
                  title={t('拖动排序（或用上下方向键）')}
                  onPointerDown={(e) =>
                    handleGripPointerDown(e, rule.id, index)
                  }
                  onPointerMove={handleGripPointerMove}
                  onPointerUp={handleGripPointerUp}
                  onPointerCancel={handleGripPointerCancel}
                  onKeyDown={(e) => handleGripKeyDown(e, rule.id)}>
                  <DragSvg />
                </span>
              ) : (
                /* 只有一条规则时无从排序：留等宽占位保持左对齐，
                   但不做成可拖 / 可聚焦的控件（否则多一个死的 Tab 停靠点） */
                <span className="rule-grip-spacer" aria-hidden="true" />
              )}

              <div className="rule-main">
                <div className="rule-head">
                  {/* 名称会被 ellipsis 截断，title 保证悬停能看到全称 */}
                  <span className="rule-name" title={rule.name}>
                    {rule.name || t('未命名规则')}
                  </span>
                  {/* 类型 + 比较方式合并为一个徽标（分开渲染会在窄列表里挤掉规则名） */}
                  <span className="rule-badge">{kindBadgeLabel(rule)}</span>
                  {rule.kind !== 'js' && rule.caseSensitive && (
                    <span className="rule-badge subtle">
                      {t('区分大小写')}
                    </span>
                  )}
                </div>
                <code className="rule-pattern" title={rule.pattern}>
                  {rule.pattern}
                </code>
              </div>

              <div className="rule-actions">
                {/* 启停开关放在行尾，与图标按钮用分隔线分组 */}
                <Toggle
                  size="sm"
                  checked={rule.enabled}
                  ariaLabel={t('启用该规则')}
                  title={t('启用 / 禁用')}
                  onChange={(v) =>
                    securityStore.setSandboxRuleEnabled(rule.id, v)
                  }
                />
                <span className="rule-actions-sep" aria-hidden="true" />
                <button
                  className="rule-icon-btn"
                  title={t('编辑')}
                  onClick={() => openEdit(rule)}>
                  <EditSvg />
                </button>
                <button
                  className="rule-icon-btn danger"
                  title={t('删除')}
                  onClick={() => removeRule(rule)}>
                  <DeleteSvg />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        visible={!!draft}
        title={isNew ? t('新增规则') : t('编辑规则')}
        onClose={close}
        width="min(680px, 86vw)"
        footer={
          <>
            <button className="btn-cancel" onClick={close}>
              {t('取消')}
            </button>
            <button
              className="btn-confirm"
              onClick={save}
              disabled={!canSave}
              title={canSave ? undefined : t('请先填写规则名称与匹配内容')}>
              {t('保存')}
            </button>
          </>
        }>
        {draft && (
          <div className="rule-form">
            <div className="form-row">
              <span className="form-label">{t('规则名称')}</span>
              <input
                className="form-input"
                autoFocus
                value={draft.name}
                placeholder={t('例如：前端安装依赖')}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>

            <div className="form-row column">
              <span className="form-label">{t('匹配方式')}</span>
              <div className="segmented-control">
                {KIND_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={`segment ${draft.kind === o.value ? 'active' : ''}`}
                    onClick={() => changeKind(o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="form-hint">
                {t('切换匹配方式会重置下方「匹配内容」')}
              </span>
            </div>

            {draft.kind === 'text' && (
              <div className="form-row">
                <span className="form-label">{t('比较方式')}</span>
                <div className="segmented-control">
                  {TEXT_MODE_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      className={`segment ${draft.textMode === o.value ? 'active' : ''}`}
                      onClick={() => update({ textMode: o.value })}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {draft.kind !== 'js' && (
              <div className="form-row">
                <span className="form-label">{t('区分大小写')}</span>
                <Toggle
                  checked={draft.caseSensitive}
                  ariaLabel={t('区分大小写')}
                  onChange={(v) => update({ caseSensitive: v })}
                />
              </div>
            )}

            <div className="form-row column">
              <div className="form-label-row">
                <span className="form-label">
                  {draft.kind === 'js' ? t('JS 函数体') : t('匹配内容')}
                </span>
                {/* 默认模板已预填，改乱了想从头开始的退路（内容已变才出现） */}
                {draft.kind === 'js' &&
                  draft.pattern !== SANDBOX_JS_DEFAULT_PATTERN && (
                    <button className="link-btn" onClick={resetJsPattern}>
                      {t('重置为默认模板')}
                    </button>
                  )}
              </div>
              {draft.kind === 'js' ? (
                <CodeEditor
                  value={draft.pattern}
                  language="javascript"
                  height={200}
                  ariaLabel={t('JS 函数体')}
                  onChange={(v) => update({ pattern: v })}
                />
              ) : (
                <textarea
                  className="form-textarea"
                  rows={2}
                  value={draft.pattern}
                  placeholder={patternPlaceholder}
                  spellCheck={false}
                  onChange={(e) => update({ pattern: e.target.value })}
                />
              )}
              <span className="form-hint">
                {draft.kind === 'text'
                  ? t('按上面的比较方式，与 AI 实际执行的命令文本做比较（忽略首尾空白）')
                  : draft.kind === 'regex'
                    ? t('JavaScript 正则，与整条命令做匹配（test 语义）')
                    : t(
                        '写一个函数，参数 command 是 AI 实际要执行的命令，返回真值即命中。默认模板返回 false（不命中），请按需修改；请只写你自己信任的代码。',
                      )}
              </span>
            </div>

            <div className="form-row">
              <span className="form-label">{t('启用该规则')}</span>
              <Toggle
                checked={draft.enabled}
                ariaLabel={t('启用该规则')}
                onChange={(v) => update({ enabled: v })}
              />
            </div>

            <div className="form-test">
              <span className="form-label">{t('测试命令')}</span>
              <div className="form-test-row">
                <input
                  className="form-input"
                  value={sample}
                  placeholder={t('输入一条命令试跑，例如：pnpm test')}
                  onChange={(e) => {
                    setSample(e.target.value)
                    setTestResult(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && runTest()}
                />
                <button
                  className="btn-test"
                  onClick={runTest}
                  disabled={!sample.trim()}>
                  {t('测试')}
                </button>
              </div>
              {testResult && (
                <div
                  className={`test-result ${
                    testResult.error
                      ? 'error'
                      : testResult.matched
                        ? 'matched'
                        : 'unmatched'
                  }`}>
                  {testResult.error
                    ? tpl('规则报错（按未命中处理）：$__error__', {
                        error: testResult.error,
                      })
                    : testResult.matched
                      ? t('命中：该命令将以「不使用沙盒」方式执行（免脱壳授权）')
                      : t('未命中')}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
})

export default SandboxIgnoreRules
