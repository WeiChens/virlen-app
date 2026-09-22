/**
 * skill-list —— 侧边栏「技能」页签
 *
 * 列出已安装技能（skillStore 里已注册的 SKILL.md 元信息），与
 * 「设置 → 技能」同源：导入 / 删除后此处自动同步（skillStore 是 observable）。
 *
 * 交互（与目录树同一套指针拖拽，见 use-tree-drag.ts）：
 *   - 单击卡片 / 拖到输入框 → **开关式**引用：未引用则引用，已引用则取消
 *   - 已引用的卡片高亮（+「已引用」角标），与输入框里的技能 chip 一一对应
 *   - 右键菜单              → 引用 / 取消引用 / 打开技能目录 / 在文件管理器中显示 / 复制路径
 *
 * ⚠️ 「打开技能目录」已从单击挪到右键菜单：单击现在是引用开关（原来点一下就把目录弹到
 * 资源管理器，与「引用」放在同一个手势上必然二选一）。
 *
 * 引用状态的**唯一真相在输入框**（它持有 SKILL.md 全文，见 input/hooks.ts）：
 * 这里只是拿 chat-view 传下来的名字镜像来判断高亮，点击时回给输入框执行。
 */
import { observer } from 'mobx-react-lite'
import { openPath } from '@tauri-apps/plugin-opener'
import { listRegisteredSkills, type RegisteredSkill } from '@/skill'
import { showToast } from '@/ui/components/shared/Toast'
import { rowKeyHandler } from '@/utils/a11y'
import { t, tpl } from '@/ui/i18n'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import { fileMenuItems } from '@/ui/components/shared/ContextMenu/menus'
import { useTreeDrag } from './use-tree-drag'

interface Props {
  /** 把技能引用挂到输入框（按技能名读 SKILL.md 全文） */
  onAttachSkills: (names: string[]) => void
  /** 输入框当前已引用的技能名 */
  referencedSkills: string[]
  /** 单击卡片：未引用则引用，已引用则取消 */
  onToggleSkill: (name: string) => void
}

/** 右键菜单指向的技能 */
interface SkillMenuTarget {
  name: string
  path: string
}

function SkillList({
  onAttachSkills,
  referencedSkills,
  onToggleSkill,
}: Props) {
  // 读 skillStore → observer 追踪，设置页增删技能后无需手动刷新
  const skills = listRegisteredSkills()
  const menu = useContextMenu<SkillMenuTarget>()
  /** 已引用的技能名集合（数组很小，直接建 Set 判定） */
  const referenced = new Set(referencedSkills)

  const { startDrag, draggedRef } = useTreeDrag({
    onDropToInput: (items) => onAttachSkills(items.map((item) => item.name)),
    // 技能卡片没有「拖进目录」这种落点（页面里不存在 [data-tree-dir]），空实现即可
    onDropIntoDir: () => {},
  })

  /** 右键菜单项：先「引用 / 取消引用」，再走文件菜单（目录形态，会隐掉「编辑器打开」） */
  function buildMenuItems(target: SkillMenuTarget): ContextMenuItem[] {
    const isReferenced = referenced.has(target.name)
    return [
      {
        key: 'toggle',
        label: isReferenced ? t('取消引用') : t('引用到输入框'),
        onClick: () => onToggleSkill(target.name),
      },
      {
        key: 'open-dir',
        label: t('打开技能目录'),
        divider: true,
        onClick: () => {
          openPath(target.path).catch(() => showToast(t('打开失败')))
        },
      },
      // 「打开文件夹」与本菜单的「打开技能目录」是同一件事，去掉避免两个重复项；
      // 保留「在文件管理器中显示 / 复制路径」（复用既有实现，不重写）
      ...fileMenuItems(target.path, { isDir: true }).filter(
        (item) => item.key !== 'open',
      ),
    ]
  }

  /** 单击 = 开关式引用（拖拽松手后浏览器仍会补一次 click，需吞掉） */
  const handleCardClick = (skill: RegisteredSkill) => {
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    onToggleSkill(skill.meta.name)
  }

  /** 按下即把这张卡片交给拖拽 hook；ghost 用技能图标区分于文件行 */
  const handleCardPointerDown = (
    e: React.PointerEvent,
    skill: RegisteredSkill,
  ) => {
    if ((e.target as HTMLElement).closest('button, input')) return
    startDrag(e, [
      { path: skill.path, name: skill.meta.name, isDir: false, icon: '🧩' },
    ])
  }

  if (skills.length === 0) {
    return (
      <div className="skill-list-panel">
        <div className="sidebar-empty">
          <p>{t('暂无已安装技能')}</p>
          <p className="hint">{t('可在「设置 → 技能」中导入技能')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="skill-list-panel">
        <div className="skill-list-count">
          <span>{tpl('共 $__count__ 个技能', { count: skills.length })}</span>
          {/* 单击是「开关」，on / off 都要写明，否则看不出还能再点一下 */}
          <span className="skill-list-hint">
            {t('单击引用 / 取消引用')}
          </span>
        </div>
        <div className="skill-items">
          {skills.map((skill) => {
            const isReferenced = referenced.has(skill.meta.name)
            return (
              <div
                className={`skill-card${isReferenced ? ' is-referenced' : ''}`}
                key={skill.meta.name}>
                <div
                  className="skill-card-main"
                  role="button"
                  tabIndex={0}
                  // 开关按钮：读屏会播报「按下/未按下」
                  aria-pressed={isReferenced}
                  aria-label={skill.meta.name}
                  title={
                    isReferenced ? t('点击取消引用') : t('引用到输入框')
                  }
                  onPointerDown={(e) => handleCardPointerDown(e, skill)}
                  onClick={() => handleCardClick(skill)}
                  onContextMenu={(e) =>
                    menu.openAt(e, { name: skill.meta.name, path: skill.path })
                  }
                  onKeyDown={rowKeyHandler(() => handleCardClick(skill))}>
                  <div className="skill-card-name-row">
                    <span className="skill-card-name">{skill.meta.name}</span>
                    {isReferenced && (
                      <span className="skill-card-ref">{t('已引用')}</span>
                    )}
                    {skill.meta.version && (
                      <span className="skill-card-version">
                        v{skill.meta.version}
                      </span>
                    )}
                  </div>
                  {skill.meta.description && (
                    <span className="skill-card-desc">
                      {skill.meta.description}
                    </span>
                  )}
                  {skill.meta.tags && skill.meta.tags.length > 0 && (
                    <div className="skill-card-tags">
                      {skill.meta.tags.map((tag) => (
                        <span className="skill-card-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={buildMenuItems(menu.state.target)}
          onClose={menu.close}
        />
      )}
    </>
  )
}

export default observer(SkillList)
