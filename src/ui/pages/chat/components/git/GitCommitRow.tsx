/**
 * GitCommitRow — 提交行（**两处共用**：「提交记录」与「提交图」）。
 *
 * 一行四样东西一眼可见：**提交信息 / 提交用户 / 提交时间 / 短 hash**（完整的 oid 与原始时间戳进
 * `title`，悬停可看）。收在一处而不是各写一份：右侧那三列的**定宽对齐口径**（时间列 100px、
 * 名字右边界挂在时间列上）分头写就一定会漂（§11.53 ⑰）。
 *
 * `onOpen`：点行打开**提交详情**（`GitCommitModal`）。有它才是可点的 —— 同时给 `role` / `tabIndex` /
 * 回车键，否则这条信息只给了鼠标用户（键盘用户在提交图里什么都打不开）。
 *
 * 两个可选零件（只有提交图传）：
 * - `gutter`：左侧图列的宽度 —— ⚠️ 这里只**留位置**（一个空盒子），线与点由 `GraphCanvas` 画在
 *   滚动容器之外的固定画布上；把 canvas 塞进每行的话，行数一多就是几千个 canvas；
 * - `refs`：分支 / 标签标签（**这条线是谁**）。⚠️ **每行只展示一个**（本地优先，口径见
 *   `graph.ts::pickRowRefs`）：同一个提交几乎总是同时挂着 `master` 与 `origin/master`，
 *   两个都摆出来是噪声；剩下的收进 `+n` 徽标，悬停给出它们是谁。
 *   颜色不是身份标识（无交集的分支允许同色），所以名字必须显式写出来。
 */
import { t, tpl } from '@/ui/i18n'
import { formatCommitTime } from '@/utils/time'
import { pickRowRefs, type GitCommitLogEntry, type GraphRef } from '@/domain/git'

interface Props {
  entry: GitCommitLogEntry
  /** 左侧图列宽度（px）—— 只有提交图传 */
  gutter?: number
  /** 在图列里显示的引用标签 —— 只有提交图传 */
  refs?: GraphRef[]
  /** 点开这条提交的详情（不传 = 不可点：本组件在两处弹窗里都传，测试里可以只验渲染） */
  onOpen?: (oid: string) => void
}

/** 引用标签的悬停提示：把「这是哪一类引用」说清楚（`origin/master` 光看名字分不出本地还是远程） */
function refTitle(ref: GraphRef): string {
  switch (ref.kind) {
    case 'head':
      return tpl('当前分支：$__name__', { name: ref.name })
    case 'tag':
      return tpl('标签：$__name__', { name: ref.name })
    case 'remote':
      return tpl('远程分支：$__name__', { name: ref.name })
    default:
      return tpl('分支：$__name__', { name: ref.name })
  }
}

/**
 * `+n` 徽标的悬停详情：把被收起来的那几条**逐个列出来**（就知道这个 `+4` 里是什么了）。
 * 分隔用 ` · `（引用名里不可能有空格，而句子里全是冒号与空格，只有它读得开）。
 */
function hiddenTitle(hidden: GraphRef[]): string {
  return tpl('另有 $__count__ 个引用：$__list__', {
    count: hidden.length,
    list: hidden.map(refTitle).join(' · '),
  })
}

export function GitCommitRow({ entry, gutter, refs, onOpen }: Props) {
  // 只展示一个（本地优先）+ 剩下的全部进徽标；详情（悬停）也是这里算出来的
  const picked = pickRowRefs(refs ?? [])
  const time = formatCommitTime(entry.author_time)
  return (
    <div
      className={`git-log-row${onOpen ? ' is-clickable' : ''}`}
      data-oid={entry.oid}
      // 可点就必须可键盘操作（回车 / 空格），否则等于把这条信息只给了鼠标用户
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      title={onOpen ? t('查看这次提交改了什么') : undefined}
      onClick={onOpen ? () => onOpen(entry.oid) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onOpen(entry.oid)
            }
          : undefined
      }>
      {gutter !== undefined && (
        // 纯占位：无障碍树里没有信息（线与点的语义在标题里说明），别让读屏念一个空盒子
        <span className="git-graph-gutter" style={{ width: gutter }} aria-hidden="true" />
      )}
      {picked.shown && (
        <span className={`git-log-ref is-${picked.shown.kind}`} title={refTitle(picked.shown)}>
          {picked.shown.name}
        </span>
      )}
      {picked.hidden.length > 0 && (
        <span className="git-log-ref is-more" title={hiddenTitle(picked.hidden)}>
          {`+${picked.hidden.length}`}
        </span>
      )}
      <span className="git-log-subject" title={entry.subject}>
        {/* 空标题（`--allow-empty-message`）给个占位，免得画出一条什么都没有的行 */}
        {entry.subject || t('（无提交信息）')}
      </span>
      <span className="git-log-meta">
        {/* 悬停给出「名字 <邮箱>」：名字被定宽截断时还看得到全名 */}
        <span
          className="git-log-author"
          title={`${entry.author_name} <${entry.author_email}>`}>
          {entry.author_name}
        </span>
        <span className="git-log-time" title={entry.author_time}>
          {/* 解析不出来的时间戳照原样显示（宁可是个怪字符串，也不是一个假时间） */}
          {time || entry.author_time}
        </span>
        <code className="git-log-hash" title={entry.oid}>
          {entry.short_oid}
        </code>
      </span>
    </div>
  )
}

export default GitCommitRow