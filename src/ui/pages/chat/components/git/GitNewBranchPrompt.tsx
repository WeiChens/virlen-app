/**
 * GitNewBranchPrompt — 「在此提交上新建分支」的分支名输入框。
 *
 * 三条口径：
 * - 名字合法性**只信 Rust 的 `git check-ref-format`**（`git-service.checkRefFormat`，与
 *   `GitBranchMenu` 同一个判据）：自己写正则必然漏规则（`..` / 结尾 `.lock` / 控制字符…），
 *   漏了就是「界面放行、git 报错」的错位；
 * - 新建 = **建好并切过去**（`git switch -c <name> <oid>`）—— 点「在这笔提交上新建分支」的人，
 *   下一步就要在这条历史上下手，建完还把他留在原分支上只会让他再找一次；
 * - 失败（如脏工作区与目标冲突）由 `switchBranch` 带回 git 原文并弹错误窗，这里**不关弹窗**：
 *   用户就地换个名字、或先去处理工作区，输入不丢。
 *
 * ⚠️ Esc 的归属：Modal 自己会关这一层，而宿主的 Esc 监听挂在 document 的**捕获阶段** ——
 * 两个提交弹窗（`GitLogModal` / `GitGraphModal`）必须在内层弹窗开着时让路
 * （见它们各自的 `innerRef`），否则一次 Esc 会把提交记录/提交图一起关掉。
 */
import { useEffect, useState } from 'react'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { t, tpl } from '@/ui/i18n'
import { checkRefFormat, switchBranch } from '@/services/git-service'

interface Props {
  /** 新分支从哪笔提交上长出来（完整 oid） */
  oid: string
  /** 那笔提交的标题（只用于说清「从哪一笔」；为空时退到短 oid） */
  subject: string
  /** 只读沙盒 / 有操作在跑 → 不给建（Rust 侧同样会拒，这里是体验层） */
  disabled: boolean
  onClose: () => void
}

export function GitNewBranchPrompt({
  oid,
  subject,
  disabled,
  onClose,
}: Props) {
  const [name, setName] = useState('')
  /** `null` = 还在校验（此时既不报错也不许提交） */
  const [valid, setValid] = useState<boolean | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const trimmed = name.trim()
  const label = subject.trim() || oid.slice(0, 7)

  // 名字合法性交给 Rust（权威判定）：输入一变就重新校验，上一次的回包作废
  useEffect(() => {
    if (!trimmed) {
      setValid(null)
      return
    }
    let alive = true
    setValid(null)
    void checkRefFormat(trimmed).then((ok) => {
      if (alive) setValid(ok)
    })
    return () => {
      alive = false
    }
  }, [trimmed])

  async function submit(): Promise<void> {
    if (!trimmed || valid !== true || disabled || submitting) return
    setSubmitting(true)
    const ok = await switchBranch(trimmed, true, oid)
    setSubmitting(false)
    // 成功才关：失败时 git 的原因在错误窗里，输入保留，用户就地改名再试
    if (ok) onClose()
  }

  return (
    <Modal
      visible
      width={420}
      title={t('在此提交上新建分支')}
      onClose={onClose}
      footer={
        <ModalFooterButtons
          onCancel={onClose}
          onConfirm={() => void submit()}
          cancelText={t('取消')}
          confirmText={t('创建并切换')}
          confirmLoading={submitting}
          confirmDisabled={valid !== true || disabled}
        />
      }>
      <div className="git-new-branch">
        <div className="git-new-branch-hint">
          {tpl('新分支会从「$__subject__」开始，并立即切换过去。', {
            subject: label,
          })}
        </div>
        <input
          className="git-new-branch-input"
          autoFocus
          value={name}
          placeholder={t('输入新的分支名')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            void submit()
          }}
        />
        {/* 出错提示常驻一行高度：校验中与合法时为空，避免弹窗高度跳动 */}
        <div className="git-new-branch-error">
          {valid === false ? t('不是合法的分支名') : ''}
        </div>
      </div>
    </Modal>
  )
}

export default GitNewBranchPrompt
