/**
 * MemoryEditModal — 新增 / 编辑一条记忆（子弹窗）
 *
 * 独立弹窗而非列表内联表单：列表是一张**表格**（每页 20 条，一眼扫一片），内联表单会把表格往下
 * 推、挤掉「一屏看更多」这个目标；点行弹子弹窗既不动布局，也与知识库文档弹窗同一范式。
 *
 * 嵌套弹窗的键盘行为由 `Modal` 处理：Esc 只关**最上层**那个（见 `Modal/index.tsx`）。
 */
import { useEffect, useState } from 'react'
import Modal from '@/ui/components/shared/Modal'
import Select from '@/ui/components/shared/Select'
import { showToast } from '@/ui/components/shared/Toast'
import { t, tpl } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import { upsertMemory } from '@/infrastructure/memoryRepo'
import {
  MEMORY_KIND_PROJECT,
  MEMORY_PROJECT_PATH_MAX_CHARS,
  MEMORY_SUMMARY_HINT_CHARS,
  MEMORY_SUMMARY_MAX_CHARS,
  type MemoryKind,
  type MemoryLevel,
  type MemoryRecord,
} from '@/domain/memory'
import { kindOptions, levelOptions } from './labels'
import { memoryDateTitle } from './format'

interface Props {
  visible: boolean
  /** 编辑目标；`null` = 新增 */
  item: MemoryRecord | null
  onClose: () => void
  /** 保存成功后的回调（父级据此重取列表与注入段） */
  onSaved: () => void | Promise<void>
}

/** 草稿（新增 / 编辑共用一份表单状态） */
interface MemoryDraft {
  id?: string
  summary: string
  kind: MemoryKind
  level: MemoryLevel
  disabled: boolean
  /**
   * 项目路径 —— **只有分类是「项目」时**才编辑它（其它分类一律空串）。
   * 空串 = 不限定项目（跨项目通用）；服务端还会再守一道（非 project 带路径会被清掉）。
   */
  projectPath: string
  /** 详情链接（不在表单里编辑，但要**原样回传** —— 否则编辑摘要会把蒸馏写的详情链静默清空） */
  detailKbId?: string | null
  detailDocId?: string | null
}

function toDraft(item: MemoryRecord | null): MemoryDraft {
  if (!item) {
    return { summary: '', kind: 'project', level: 'normal', disabled: false, projectPath: '' }
  }
  return {
    id: item.id,
    summary: item.summary,
    kind: (item.kind as MemoryKind) ?? 'fact',
    level: item.level === 'permanent' ? 'permanent' : 'normal',
    disabled: !!item.disabled,
    projectPath: item.projectPath ?? '',
    detailKbId: item.detailKbId ?? null,
    detailDocId: item.detailDocId ?? null,
  }
}

function MemoryEditModal({ visible, item, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<MemoryDraft>(() => toDraft(item))

  // 打开时按当前目标重置草稿：编辑 A 之后点 B，表单里绝不能还是 A 的内容
  useEffect(() => {
    if (visible) setDraft(toDraft(item))
  }, [visible, item])

  async function handleSave() {
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
      // 只有项目分类才带路径（其它分类传 null —— 服务端同样会清掉，两边一致）
      projectPath:
        draft.kind === MEMORY_KIND_PROJECT ? draft.projectPath.trim() || null : null,
      detailKbId: draft.detailKbId ?? null,
      detailDocId: draft.detailDocId ?? null,
    })
    showToast(t('已保存'), 1000)
    await onSaved()
    onClose()
  }

  const recorded = item ? memoryDateTitle(item) : ''
  /** 设置里的默认工作目录：编辑项目记忆时一键填入（用户不必手敲路径） */
  const defaultWorkspace = settingsState.value.defaultWorkspace || ''
  const isProject = draft.kind === MEMORY_KIND_PROJECT

  return (
    <Modal
      visible={visible}
      title={item ? t('编辑记忆') : t('新增记忆')}
      onClose={onClose}
      width={560}
      className="memory-edit-modal"
      footer={
        <>
          <button className="memory-action-btn" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="memory-action-btn primary" onClick={() => void handleSave()}>
            {t('保存')}
          </button>
        </>
      }>
      <div className="memory-form">
        <textarea
          className="memory-form-summary"
          value={draft.summary}
          // 自动聚焦：进来的动作就是「写内容」，不该再让用户点一下输入框
          autoFocus
          maxLength={MEMORY_SUMMARY_MAX_CHARS}
          placeholder={t('例如：这个项目用 pnpm build 构建')}
          onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
        />
        <div className="memory-form-hint">
          {tpl('写短一点更好记：建议 $__hint__ 字以内，最多 $__max__ 字。', {
            hint: MEMORY_SUMMARY_HINT_CHARS,
            max: MEMORY_SUMMARY_MAX_CHARS,
          })}
        </div>
        <div className="memory-form-row">
          <label>
            <span>{t('分类')}</span>
            {/* 用共享 `Select`：下拉面板 Portal 到 body，不会被弹窗的滚动容器裁剪 */}
            <Select
              value={draft.kind}
              // 改成非项目时顺手把路径清掉：不给「非项目却带路径」的半状态留机会
              onChange={(v) =>
                setDraft({ ...draft, kind: v as MemoryKind, projectPath: '' })
              }
              options={kindOptions()}
              width={120}
            />
          </label>
          <label>
            <span>{t('级别')}</span>
            <Select
              value={draft.level}
              onChange={(v) => setDraft({ ...draft, level: v as MemoryLevel })}
              options={levelOptions()}
              width={120}
            />
          </label>
        </div>
        {/* 项目路径只对「项目」分类显示 —— 它是这条记忆的可见范围，不能藏起来；
            空 = 所有项目可见，填了 = 只在该路径（或其子目录）的会话里注入 */}
        {isProject && (
          <div className="memory-form-row memory-form-scope">
            <label>
              <span>{t('只在这个项目里带上')}</span>
              <input
                className="memory-form-path"
                type="text"
                value={draft.projectPath}
                maxLength={MEMORY_PROJECT_PATH_MAX_CHARS}
                placeholder={t('留空 = 所有项目都带上')}
                onChange={(e) => setDraft({ ...draft, projectPath: e.target.value })}
              />
            </label>
            {defaultWorkspace && (
              <button
                className="memory-action-btn"
                onClick={() => setDraft({ ...draft, projectPath: defaultWorkspace })}>
                {t('用默认工作目录')}
              </button>
            )}
          </div>
        )}
        {/* 记录时间只读展示：用户编辑时最想确认的就是「这条是什么时候记下的」 */}
        {recorded && <div className="memory-form-hint">{recorded}</div>}
      </div>
    </Modal>
  )
}

export default MemoryEditModal
