/**
 * ReadSkillSourceMessage — read_skill_source 工具调用的消息展示组件
 *
 * 一行：技能名（+ 结果里解析出的技能路径，灰色省略）
 * 展开：技能源码卡片（对齐 message/code-block 的视觉语言）
 *   · 标题条（sticky）：技能名 + 「打开技能目录」图标按钮
 *   · 元信息行：技能路径（等宽、省略）
 *   · 分区：目录结构（等宽 <pre>）、SKILL.md（Markdown 渲染）
 *   · 展开时「打开即居中」（useAutoCenter，与 read_file / edit_file 一致）
 *
 * ⚠️ 「打开即居中」的 hook 只能在**组件顶层**无条件调用（见 useAutoCenter 文档与
 *    `tests/ui/tool-call-autocenter.test.tsx` 的回归说明）：写在类方法里属条件调用 hook，
 *    会让 React 记账错乱。因此展开视图拆成 `SkillSourceView` 函数组件承载 hook。
 *
 * ⚠️ 结果由 `infrastructure/tools/skill/read-skill-source.ts` 生成：
 *    · 新数据走**结构化 `uiData`**（`{ skillPath, tree, md }`，语言无关）；
 *    · 旧数据只有文本，这里回退解析 `content` 的中文分段标记。
 *    两条路都取不到时**不做猜测**，整段回退为 `<pre>` 原文，
 *    否则会出现「把 SKILL.md 正文错当成目录树渲染」这类静默错位。
 */
import { t } from '@/ui/i18n'
import { toShortPath } from '@/utils/common'
import { showToast } from '@/ui/components/shared/Toast'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import { useAutoCenter } from '@/ui/hooks/useAutoCenter'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import { openPath } from '@tauri-apps/plugin-opener'
import MarkdownRenderer from '../message/markdown-renderer'
import { IToolCallMessage, ToolMessageProps } from './IToolCallMessage'

/** 目录结构分段标记（与 read-skill-source.ts 的拼装顺序一致） */
const TREE_MARK = '# 📂 目录结构'
/** SKILL.md 分段标记 */
const MD_MARK = '# 📄 SKILL.md'
/** 技能路径行：`**📁 技能路径**: \`C:/...\`` */
const PATH_RE = /\*\*📁\s*技能路径\*\*\s*[:：]\s*`([^`]+)`/

export interface SkillSourceParts {
  /** 技能文件夹绝对路径（解析不到时为空串） */
  skillPath: string
  /** 目录结构文本（不含标记行与分隔线） */
  tree: string
  /** SKILL.md 正文 */
  skillMd: string
}

/**
 * 优先用结构化 `uiData`（新数据）。三段都为空视为「没有可用结构」，交由调用方回退。
 */
function partsFromUiData(ui: unknown): SkillSourceParts | null {
  if (!ui || typeof ui !== 'object') return null
  const d = ui as Record<string, unknown>
  const skillPath = typeof d.skillPath === 'string' ? d.skillPath : ''
  const tree = typeof d.tree === 'string' ? d.tree : ''
  const skillMd = typeof d.md === 'string' ? d.md : ''
  if (!skillPath && !tree && !skillMd) return null
  return { skillPath, tree, skillMd }
}

/**
 * 目录结构段的行级修剪：只去掉首尾的空行与 `---` 分隔线。
 *
 * 为什么不整段 replace 所有 `---`：SKILL.md 的 YAML frontmatter 也用 `---` 包起来，
 * 一刀切会把正文改坏；而目录树段只可能在首尾出现分隔线。
 */
function trimTreeSection(raw: string): string {
  const lines = raw.split('\n')
  const isBlankOrRule = (line: string) =>
    !line.trim() || line.trim() === '---'
  while (lines.length > 0 && isBlankOrRule(lines[0])) lines.shift()
  while (lines.length > 0 && isBlankOrRule(lines[lines.length - 1])) lines.pop()
  return lines.join('\n')
}

/**
 * 解析 read_skill_source 的结果文本。
 *
 * @returns 三段都拿不到时返回 null（调用方回退为原文展示）
 */
export function parseSkillSourceContent(
  content: string,
): SkillSourceParts | null {
  if (!content) return null

  const skillPath = content.match(PATH_RE)?.[1]?.trim() || ''

  const treeIdx = content.indexOf(TREE_MARK)
  const mdIdx =
    treeIdx === -1
      ? content.indexOf(MD_MARK)
      : content.indexOf(MD_MARK, treeIdx + TREE_MARK.length)

  const tree =
    treeIdx !== -1 && mdIdx > treeIdx
      ? trimTreeSection(content.slice(treeIdx + TREE_MARK.length, mdIdx))
      : ''
  const skillMd =
    mdIdx !== -1
      ? content.slice(mdIdx + MD_MARK.length).replace(/^\s+/, '').trimEnd()
      : ''

  if (!skillPath && !tree && !skillMd) return null
  return { skillPath, tree, skillMd }
}

/** 取当前会话工作目录（与 TerminalBlock / securityService 一致） */
function currentWorkspace(): string {
  return (
    sessionStore.getSession(chatState.value.currentSessionId)?.workspace ||
    settingsState.value.defaultWorkspace ||
    ''
  )
}

/**
 * 展开视图根组件。
 *
 * 只承载「需要 hook / 需要 workspace」的渲染：类方法里不能调 hook，
 * 而 workspace 每次渲染都要取最新值（会话可能已切换）。
 */
function SkillSourceView({
  name,
  parts,
  raw,
}: {
  name: string
  parts: SkillSourceParts | null
  raw: string
}) {
  // ⚠️ 顶层无条件调用：本组件只在用户展开时挂载（折叠时 getExpandView 返回 null），
  //    所以「挂载」本身就等价于一次用户手势，不会被动的消息到达/列表重挂载触发。
  const rootRef = useAutoCenter()
  const skillPath = parts?.skillPath || ''

  return (
    <div className="skill-source-view" ref={rootRef}>
      {parts ? (
        <>
          <div className="skill-source-header">
            <span className="skill-source-name">{name}</span>
            {skillPath && (
              <button
                className="skill-source-icon-btn"
                title={t('打开技能目录')}
                aria-label={t('打开技能目录')}
                onClick={(e) => {
                  // 卡片本身点了会折叠，按钮上的点击必须拦下来
                  e.stopPropagation()
                  openPath(skillPath).catch(() =>
                    showToast(t('打开失败'), 2000),
                  )
                }}>
                <FolderSvg fill="currentColor" />
              </button>
            )}
          </div>

          {skillPath && (
            <div className="skill-source-meta">
              <span className="skill-source-meta-label">{t('技能路径')}</span>
              <span className="skill-source-meta-path" title={skillPath}>
                {toShortPath(skillPath, currentWorkspace())}
              </span>
            </div>
          )}

          {parts.tree && (
            <div className="skill-source-section">
              <div className="skill-source-section-title">{t('目录结构')}</div>
              <pre className="skill-source-tree">{parts.tree}</pre>
            </div>
          )}

          {parts.skillMd && (
            <div className="skill-source-section">
              <div className="skill-source-section-title">SKILL.md</div>
              <div className="skill-source-md">
                <MarkdownRenderer content={parts.skillMd} />
              </div>
            </div>
          )}
        </>
      ) : (
        // 结构标记缺失：宁可显示原文，也不要按猜测的分段渲染
        <pre className="skill-source-raw">{raw}</pre>
      )}
    </div>
  )
}

class ReadSkillSourceMessage implements IToolCallMessage {
  getToolName(): string {
    return 'read_skill_source'
  }

  getToolLabel(_type: string): string {
    return t('查看技能源代码')
  }

  getShortText(props: ToolMessageProps): React.ReactNode {
    try {
      const name = (props.useContent.input as any)?.name || ''
      // 定位技能路径：新数据直接取 uiData；旧数据只扫结果开头（正文可达数十 KB）
      const head =
        typeof props.message?.content === 'string'
          ? props.message.content.slice(0, 300)
          : ''
      const skillPath =
        partsFromUiData(props.message?.uiData)?.skillPath ||
        head.match(PATH_RE)?.[1]?.trim() ||
        ''

      // 入参缺失（如工具直接报错）时没有技能名可展示，退回结果开头的一句话
      if (!name) {
        const fallback =
          typeof props.message?.content === 'string'
            ? props.message.content.slice(0, 60)
            : ''
        return fallback || t('查看技能源代码')
      }

      return (
        <div className="skill-source-short">
          <span className="skill-source-short-name">{name}</span>
          {skillPath && (
            <span className="skill-source-short-path" title={skillPath}>
              {toShortPath(skillPath, currentWorkspace())}
            </span>
          )}
        </div>
      )
    } catch {
      return t('解析异常')
    }
  }

  getExpandView(props: ToolMessageProps): React.ReactNode {
    // diyWrapper() 为 true：外层不再帮我们判 expand，这里必须自己早退，
    // 否则折叠状态也会把整张卡片渲染出来（顺带会让 autoCenter 失效/误触发）。
    if (!props.expand) return null

    const content =
      typeof props.message?.content === 'string' ? props.message.content : ''
    if (props.message?.isError) {
      return <div className="error">{content}</div>
    }
    if (!content) return null

    return (
      <SkillSourceView
        name={((props.useContent.input as any)?.name as string) || ''}
        parts={
          partsFromUiData(props.message?.uiData) ??
          parseSkillSourceContent(content)
        }
        raw={content}
      />
    )
  }

  diyWrapper(): boolean {
    // 自绘卡片（标题条 / 边框 / 宽度上限），不使用 .tool-call-expand-view 的 fit-content 包裹
    return true
  }
}

export default ReadSkillSourceMessage
