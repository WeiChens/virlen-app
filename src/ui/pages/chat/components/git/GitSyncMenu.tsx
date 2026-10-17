/**
 * GitSyncMenu — 远程浮层：远程地址 + 获取 / 拉取（仅快进）/ 推送 + 测试连接。
 *
 * 六条口径（前四条来自设计评审，都是「用户点完不知道发生了什么」那一类）：
 * - **凭据策略 = SSH**（本机密钥 / ssh-agent；应用不保存任何密码）。所以「测试连接」不是可选装饰：
 *   它是 SSH 出问题（密钥没加载、主机指纹没信任）时唯一的就地诊断入口；
 * - **成功即关**：成功不在这里重复一遍结果 —— 关掉浮层后「操作输出」块与 toast 都在原位，
 *   浮层压在上面反而挡住它们。**失败留下**：错误原文要能就着浮层读、就地再试；
 * - **进行中要看得见、能取消**：网络操作最多 10 分钟，只把按钮置灰等于让用户对着死界面等；
 * - **焦点进出有交代**：打开落第一个动作，关闭还给触发它的按钮（否则键盘用户还得从头 Tab）；
 * - 拉取 / 推送要求 HEAD 在**某个分支**上（游离 HEAD 上按名字操作无从谈起）→ 禁用 + 说明；
 * - 多个远程时让用户选：推错仓库不可逆（推上去的分支别人就能看到）。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import type { GitRemoteKind } from '@/domain/git'
import {
  cancelSync,
  fetchRemote,
  pullRemote,
  pushRemote,
  testRemote,
} from '@/services/git-service'

interface Props {
  /** 只读沙盒模式（`busy` 由浮层自己看 store —— 它还要区分「能不能点取消」） */
  readonly: boolean
  onClose: () => void
}

/** 本浮层能发出的三个操作（用于判断 `busy` 是不是自己这一个） */
const SYNC_OPS = ['fetch', 'pull', 'push']

/** 地址种类 → 徽标文案（只是展示，不参与认证决策） */
function kindLabel(kind: GitRemoteKind): string {
  switch (kind) {
    case 'ssh':
      return 'SSH'
    case 'https':
      return 'HTTPS'
    case 'http':
      return 'HTTP'
    case 'git':
      return 'git://'
    case 'file':
      return t('本地路径')
    default:
      return t('其他')
  }
}

export const GitSyncMenu = observer(function GitSyncMenu({ readonly, onClose }: Props) {
  /** 用户手选的远程（`null` = 还没选，走 origin / 唯一一个） */
  const [picked, setPicked] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  )
  /** 最近一次动作失败的原因（成功时浮层会关掉，所以这里只会是失败） */
  const [failed, setFailed] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  /** 打开前焦点在哪 —— 关闭时还回去 */
  const returnFocusRef = useRef<Element | null>(null)

  const list = gitStore.remotes
  const name = picked ?? list.find((r) => r.name === 'origin')?.name ?? list[0]?.name ?? null
  const remote = list.find((r) => r.name === name) ?? null
  const head = gitStore.snapshot?.head
  const busy = gitStore.busy !== null && SYNC_OPS.includes(gitStore.busy ?? '')
  const disabled = readonly || gitStore.busy !== null
  /** 拉取 / 推送按分支名进行 —— 游离 HEAD 上这两件事不成立 */
  const onBranch = !!head?.branch

  // 焦点：进出都要有交代（浮层里没有输入框，焦点不进来键盘用户就走不进它）
  useEffect(() => {
    returnFocusRef.current = document.activeElement
    firstActionRef.current?.focus()
    return () => {
      const back = returnFocusRef.current as HTMLElement | null
      back?.focus?.()
    }
  }, [])

  // 点浮层外关闭（与分支浮层同一套：mousedown 判断包含关系）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  // 没有输入框，Esc 走全局；捕获阶段拦下，免得被外层弹窗先吃掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /**
   * 跑一个远程动作：**成功即关**（结果由「操作输出」块与 toast 承接），失败留下并显示原文。
   * 失败原因从 `gitStore.error` 取：`run()` 在开始时清空、失败时写入，所以这里拿到的一定是本次的。
   */
  async function runAction(call: (remote: string) => Promise<boolean>): Promise<void> {
    if (!remote) return
    setFailed(null)
    const ok = await call(remote.name)
    if (ok) {
      onClose()
      return
    }
    setFailed(gitStore.error ?? t('操作失败'))
  }

  async function runTest(): Promise<void> {
    if (!remote) return
    setTesting(true)
    setTestResult(null)
    try {
      await testRemote(remote.name)
      setTestResult({ ok: true, text: t('连接正常') })
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  /** 进行中的文案（只认本浮层这三个动作，别的 busy 不在这里显示取消） */
  function busyText(): string {
    switch (gitStore.busy) {
      case 'fetch':
        return t('正在获取…')
      case 'pull':
        return t('正在拉取…')
      case 'push':
        return t('正在推送…')
      default:
        return tpl('执行中：$__op__', { op: gitStore.busy ?? '' })
    }
  }

  return (
    <div
      className="git-sync-menu"
      role="dialog"
      aria-label={t('远程操作')}
      ref={boxRef}>
      {list.length === 0 && (
        <div className="git-sync-empty">
          <div>{t('这个仓库还没有配置远程仓库')}</div>
          {/* 应用里不提供 remote add（那是终端里一行的事）—— 给可复制的原文，比一句「不行」有用 */}
          <div className="git-sync-hint">{t('在终端里执行：')}</div>
          <code>git remote add origin git@github.com:owner/repo.git</code>
        </div>
      )}

      {remote && (
        <>
          {list.length > 1 && (
            <div className="git-sync-names">
              {list.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  className={`git-sync-name${r.name === remote.name ? ' current' : ''}`}
                  onClick={() => setPicked(r.name)}>
                  {r.name}
                </button>
              ))}
            </div>
          )}

          {/* 地址行：名字 + 类型在左，诊断入口在右（它属于「这个远程对不对」，不是底部的一个动作） */}
          <div className="git-sync-head">
            <span className="git-sync-remote">{remote.name}</span>
            <span className={`git-sync-kind ${remote.kind}`}>
              {kindLabel(remote.kind)}
            </span>
            <span className="git-spacer" />
            <button
              type="button"
              className="git-sync-test"
              disabled={testing || disabled}
              onClick={() => void runTest()}>
              {testing ? t('正在连接…') : t('测试连接')}
            </button>
          </div>
          <div className="git-sync-url" title={remote.url}>
            {remote.url}
          </div>

          {/* 先告诉用户「点了会发生什么」，再给按钮：拉取 / 推送的后果差别很大 */}
          {head && (head.ahead > 0 || head.behind > 0) && (
            <div className="git-sync-track">
              <span className="git-sync-count">
                ↑{head.ahead} ↓{head.behind}
              </span>
              {head.behind > 0
                ? tpl('落后 $__count__ 个提交，可用「拉取」取回', { count: head.behind })
                : tpl('有 $__count__ 个提交未推送', { count: head.ahead })}
            </div>
          )}

          <div className="git-sync-actions">
            <button
              ref={firstActionRef}
              type="button"
              className="git-sync-btn"
              disabled={disabled}
              title={t('只更新远程跟踪分支，不改工作区')}
              onClick={() => void runAction(fetchRemote)}>
              {t('获取')}
            </button>
            <button
              type="button"
              className="git-sync-btn"
              disabled={disabled || !onBranch}
              title={t('只允许快进，快进不了会如实报错')}
              onClick={() => void runAction(pullRemote)}>
              {t('拉取（仅快进）')}
            </button>
            <button
              type="button"
              className="git-sync-btn"
              disabled={disabled || !onBranch}
              title={t('推送到远程（没有上游时自动建立跟踪）')}
              onClick={() => void runAction(pushRemote)}>
              {t('推送')}
            </button>
          </div>

          {!onBranch && (
            <div className="git-sync-hint">
              {t('游离 HEAD：先切回一个本地分支才能拉取 / 推送')}
            </div>
          )}

          {/* 进行中：状态 + 取消（最长 10 分钟的超时，不该让用户对着置灰按钮干等） */}
          {busy && (
            <div className="git-sync-busy">
              <span>{busyText()}</span>
              <span className="git-spacer" />
              <button type="button" className="git-sync-cancel" onClick={cancelSync}>
                {t('取消')}
              </button>
            </div>
          )}

          {failed && <div className="git-sync-result error">{failed}</div>}

          {testResult && (
            <div className={`git-sync-result${testResult.ok ? ' ok' : ' error'}`}>
              {testResult.text}
            </div>
          )}

          <div className="git-sync-policy">
            {t('凭据：SSH（使用本机密钥 / ssh-agent，不保存密码）')}
          </div>
        </>
      )}
    </div>
  )
})

export default GitSyncMenu
