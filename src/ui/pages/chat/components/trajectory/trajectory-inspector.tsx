/**
 * 轨迹检查器：右侧抽屉，看一条记录的全文与全部数字。
 *
 * 表格里每行只有一句摘要 —— 想看完整正文 / 工具参数 / 工具输出 / 计时拆解都在这里。
 * 正文走项目现成的 `MarkdownRenderer`（与聊天气泡同源，代码块高亮、表格、本地图片链接都一致），
 * 对话里看到什么、这里就是什么，不存在第二套渲染口径。
 */
import { useEffect, useMemo, useState, type PointerEvent, type ReactNode } from 'react'
import { contentText } from '@/domain/trajectory'
import type { TrajectoryRecord } from '@/domain/trajectory'
import { messageBodyText } from '@/utils/messageContent'
import { formatDuration } from '@/utils/time'
import { formatSize } from '@/infrastructure/tools/file/common'
import { t } from '@/ui/i18n'
import MarkdownRenderer from '../message/markdown-renderer'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import { kindLabel, recordText } from './labels'
import { TrajectoryToolCatalog } from './trajectory-tool-catalog'
import { useToolCatalog } from './use-tool-catalog'

export interface TrajectoryInspectorProps {
  record: TrajectoryRecord | null
  /** 该记录所属分组的标题（`第 1 步` / `消息` / `压缩`），由父层从轨迹里查好传入 */
  groupLabel?: string
  /** 抽屉宽度（由父层拖拽调整） */
  width: number
  onClose: () => void
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  /** 跳回聊天并定位到这条记录所属的消息 */
  onJumpToConversation: (messageId: string) => void
  /**
   * 本会话的工具白名单（`undefined` = 全部工具）；「工具」页按它过滤目录。
   * 三态语义见 `domain/tools/allowed.ts`。
   */
  allowedTools?: readonly string[]
}

interface TabItem {
  id: string
  label: string
  content: ReactNode
}

/** 本地时间（带毫秒：轨迹表的间隔常在几十毫秒量级） */
function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** 一段可滚动的纯文本块（工具参数 / 工具输出：保留原始换行与缩进） */
function TextPane({ text, mono }: { text: string; mono?: boolean }) {
  return (
    <pre className={`trajectory-pane${mono ? ' is-mono' : ''}`}>{text}</pre>
  )
}

/** 「键 - 值」一行 */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="trajectory-field">
      <span className="trajectory-field__label">{label}</span>
      <span className="trajectory-field__value">{value}</span>
    </div>
  )
}

/** 数值兜底：未知一律破折号 */
function num(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : String(value)
}

/** 账本里的调用类型 → 界面文案（未知值原样输出，不吞掉新类型） */
function requestKindLabel(kind: string): string {
  switch (kind) {
    case 'chat_round':
      return t('对话请求')
    case 'compress':
      return t('压缩摘要')
    case 'title':
      return t('标题生成')
    case 'verify':
      return t('迭代校验')
    case 'memory':
      return t('记忆蒸馏')
    case 'embedding':
      return t('向量化')
    case 'legacy':
      return t('历史回填')
    default:
      return kind
  }
}

/** 耗时来源 → 文案（检查器要能解释「这个数是怎么来的」） */
function durationSourceLabel(record: TrajectoryRecord): string {
  switch (record.durationSource) {
    case 'usage':
      return t('用量账本实测')
    case 'derived':
      return t('反推：请求发出 → 第一个工具开跑')
    case 'tool':
      return t('工具结果实测')
    default:
      return '—'
  }
}

export function TrajectoryInspector({
  record,
  groupLabel,
  width,
  onClose,
  onResizeStart,
  onJumpToConversation,
  allowedTools,
}: TrajectoryInspectorProps) {
  const [tabId, setTabId] = useState('overview')
  // 工具目录只在系统记录上装载（其它行不该为它付一次契约读取）
  const toolCatalog = useToolCatalog(allowedTools, record?.kind === 'system')

  // 换一条记录 → 回到「概述」（否则会停在上一类记录才有的 tab 上，内容区一片空白）
  useEffect(() => {
    setTabId('overview')
  }, [record?.key])

  const tabs = useMemo<TabItem[]>(() => {
    if (!record) return []
    const items: TabItem[] = []
    const body = record.message ? messageBodyText(record.message.content) : ''

    items.push({
      id: 'overview',
      label: t('概述'),
      content: (
        <>
          <Field label={t('记录')} value={`#${record.index} · ${kindLabel(record.kind)}`} />
          {groupLabel && <Field label={t('分组')} value={groupLabel} />}
          {record.messageId && (
            <Field
              label={t('消息')}
              value={<code className="trajectory-code">{record.messageId}</code>}
            />
          )}
          {record.toolName && <Field label={t('工具')} value={record.toolName} />}
          {record.startedAt !== undefined && (
            <Field label={t('开始')} value={formatClock(record.startedAt)} />
          )}
          <Field
            label={t('耗时')}
            value={record.running ? t('进行中') : durationOf(record)}
          />
          <Field
            label={t('状态')}
            value={
              record.running
                ? t('进行中')
                : record.isError
                  ? t('失败')
                  : t('已完成')
            }
          />
          {record.text && <Field label={t('摘要')} value={recordText(record)} />}
          {body && <Field label={t('正文长度')} value={`${body.length} ${t('字符')}`} />}
          {record.messageId && (
            <button
              type="button"
              className="trajectory-jump"
              onClick={() => onJumpToConversation(record.messageId!)}>
              {t('在对话中查看这条消息')}
            </button>
          )}
        </>
      ),
    })

    if (record.request) {
      const request = record.request
      items.push({
        id: 'request',
        label: t('请求'),
        content: (
          <>
            <Field label={t('模型')} value={request.model ?? '—'} />
            <Field label={t('提供方')} value={request.provider ?? '—'} />
            <Field label={t('调用类型')} value={requestKindLabel(request.kind)} />
            {request.round !== undefined && (
              <Field label={t('账本轮次')} value={`#${request.round}`} />
            )}
            <Field
              label={t('请求体大小')}
              value={
                request.requestBytes !== undefined
                  ? `${formatSize(request.requestBytes)}（${request.requestBytes.toLocaleString()} B）`
                  : '—'
              }
            />
            <Field
              label={t('请求耗时')}
              value={
                request.durationMs !== undefined
                  ? formatDuration(request.durationMs)
                  : t('未测量')
              }
            />
            <Field
              label={t('等响应头')}
              value={
                request.responseStartMs !== undefined
                  ? formatDuration(request.responseStartMs)
                  : '—'
              }
            />
            <Field
              label={t('首字节')}
              value={
                request.firstByteMs !== undefined
                  ? formatDuration(request.firstByteMs)
                  : '—'
              }
            />
            <Field
              label={t('输出速度')}
              value={
                request.tokensPerSecond !== undefined
                  ? `${request.tokensPerSecond} tok/s`
                  : '—'
              }
            />
            <Field
              label={t('用量来源')}
              value={request.estimated ? t('本地估算') : t('接口返回')}
            />
            {request.id !== undefined && (
              <Field label={t('账本流水')} value={`#${request.id}`} />
            )}
            {request.traceId && (
              <Field
                label={t('追踪 ID')}
                value={<code className="trajectory-code">{request.traceId}</code>}
              />
            )}
            <p className="trajectory-note">
              {t(
                '数据来自用量账本：每次 LLM 请求落一条流水，含首字延迟与工具参数生成 —— 所以没有工具调用的纯文本回复也有真实耗时。',
              )}
            </p>
            <p className="trajectory-note">
              {t(
                '请求体大小 = 实际发出的 JSON 字节数（含系统提示词与工具定义，不只是对话正文）。「等响应头」= 发出请求 → 收到响应头（含网络往返与服务端排队）；「首字节」= 到第一个响应字节（含首 token 之前的一切）。两者都不含后面的流式回复，完整区间看「请求耗时」。「输出速度」= 输出 token ÷（请求耗时 − 等响应头耗时），同样不算发送与排队。桥接协议（gemini 等）拿不到请求体与响应头；非流式请求无法把首字节与读取分开，这些都显示破折号。',
              )}
            </p>
          </>
        ),
      })
    }

    if (record.kind === 'tool') {
      items.push({
        id: 'arguments',
        label: t('参数'),
        content: record.toolCall ? (
          <TextPane
            mono
            text={JSON.stringify(record.toolCall.input ?? {}, null, 2)}
          />
        ) : (
          <TextPane text={t('（这条记录没有参数）')} />
        ),
      })
      items.push({
        id: 'result',
        label: t('结果'),
        content: record.result?.message ? (
          <TextPane
            mono
            text={contentText(record.result.message.content) || t('（无输出）')}
          />
        ) : (
          <TextPane text={record.running ? t('执行中…') : t('（没有结果）')} />
        ),
      })
    } else if (body) {
      items.push({
        id: 'body',
        label: record.kind === 'compacted' ? t('摘要正文') : t('正文'),
        content: (
          <div className="trajectory-markdown">
            <MarkdownRenderer
              content={body}
              isUser={record.kind === 'user'}
              streaming={false}
            />
          </div>
        ),
      })
    }

    if (record.message?.reasoningContent) {
      items.push({
        id: 'thinking',
        label: t('思考'),
        content: (
          <div className="trajectory-markdown">
            <MarkdownRenderer content={record.message.reasoningContent} />
          </div>
        ),
      })
    }

    if (record.kind === 'system') {
      // 系统提示词与工具目录是同一个「请求表面」的两面（dsh 的 SYSTEM_PROMPT_TABS 同序）
      if (record.systemPrompt) {
        items.push({
          id: 'system',
          label: t('系统提示词'),
          content: <TextPane text={record.systemPrompt} />,
        })
      }
      items.push({
        id: 'tools',
        label: t('工具'),
        content: <TrajectoryToolCatalog {...toolCatalog} />,
      })
    }

    items.push({
      id: 'timing',
      label: t('计时'),
      content: (
        <>
          <Field
            label={t('开始时刻')}
            value={
              record.startedAt !== undefined
                ? `${formatClock(record.startedAt)}（${record.startedAt}）`
                : '—'
            }
          />
          <Field label={t('自身耗时')} value={durationOf(record)} />
          <Field label={t('耗时来源')} value={durationSourceLabel(record)} />
          <Field
            label={t('思考耗时')}
            value={
              record.thinkingMs !== undefined ? formatDuration(record.thinkingMs) : '—'
            }
          />
          <Field label={t('输入 token')} value={num(record.input)} />
          <Field label={t('输出 token')} value={num(record.output)} />
          <Field label={t('缓存读取')} value={num(record.cached)} />
          <Field label={t('缓存写入')} value={num(record.cacheWrite)} />
          <p className="trajectory-note">
            {t(
              '耗时只取实测值：工具行取结果里自带的耗时；回复行优先取账本里那次请求的实测耗时，账本里没有时才退回到「请求发出 → 第一个工具开跑」的反推。两者都没有就显示破折号，而不是猜一个数。',
            )}
          </p>
        </>
      ),
    })

    return items
  }, [
    record,
    groupLabel,
    onJumpToConversation,
    toolCatalog.tools,
    toolCatalog.loading,
    toolCatalog.error,
  ])

  if (!record) return null
  const active = tabs.find((tab) => tab.id === tabId) ?? tabs[0]

  return (
    <aside
      className="trajectory-inspector"
      style={{ '--trajectory-inspector-width': `${width}px` } as React.CSSProperties}>
      <div
        className="trajectory-inspector__resizer"
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
      />
      <div className="trajectory-inspector__head">
        <div className="trajectory-inspector__title">
          <span className="trajectory-inspector__index">#{record.index}</span>
          <span className="trajectory-kind" data-kind={record.kind}>
            {kindLabel(record.kind)}
          </span>
          <span className="trajectory-inspector__subtitle">
            {record.toolName ?? recordText(record)}
          </span>
        </div>
        <button
          type="button"
          className="trajectory-inspector__close"
          onClick={onClose}
          title={t('关闭')}>
          <CloseSvg />
        </button>
      </div>
      <div className="trajectory-inspector__tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active?.id}
            className={`trajectory-tab${tab.id === active?.id ? ' is-active' : ''}`}
            onClick={() => setTabId(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div className="trajectory-inspector__body" role="tabpanel">
        {active?.content}
      </div>
    </aside>
  )
}

/** 耗时文案（未知 → 破折号） */
function durationOf(record: TrajectoryRecord): string {
  if (record.running) return t('进行中')
  if (record.durationMs === null) return '—'
  return formatDuration(record.durationMs)
}
