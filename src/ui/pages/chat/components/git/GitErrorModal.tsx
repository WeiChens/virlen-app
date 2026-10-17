/**
 * GitErrorModal — Git 操作失败的**持久**错误弹窗（替代几秒就消失的 toast）。
 *
 * 三条口径：
 * - **只能由用户关**：git 的报错是多行 stderr，真正的下一步常写在 `hint:` 行上；自动消失的提示
 *   既读不完也不能复制，用户往往要照着它去终端 / 搜索；
 * - **等宽 + 可滚动 + 可复制**：`fatal:` 与 `hint:` 的对齐、含空格的路径，只有等宽才读得准；
 * - **原文照抄**：Rust 已把 stderr 原样带回来，这里不再裁剪或改写成「操作失败」——那等于把
 *   唯一有用的信息删掉。
 *
 * 它挂在 `GitEntry` 上（面板外）：网络操作 / 用户在面板里点错之后，即使面板收起来了，报错仍在。
 */
import Modal from '@/ui/components/shared/Modal'
import { t, tpl } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { copyText } from '@/utils/clipboard'

interface Props {
  /** 失败的动作标签（与 `run()` 的 label 同源，如 `commit` / `branch_switch`） */
  op: string
  /** git 的 stderr 原文 */
  text: string
  onClose: () => void
}

export function GitErrorModal({ op, text, onClose }: Props) {
  /** 复制带上动作名：单看一段 stderr，别人（或未来的自己）不知道是哪一步失败的 */
  function copy(): void {
    void copyText(`${op}\n${text}`).then((ok) => {
      if (ok) showToast(t('已复制错误信息'))
    })
  }

  return (
    <Modal
      visible
      width={520}
      title={t('操作失败')}
      onClose={onClose}
      footer={
        <>
          <button className="btn-cancel" onClick={onClose}>
            {t('关闭')}
          </button>
          <button className="btn-confirm" onClick={copy}>
            {t('复制错误信息')}
          </button>
        </>
      }>
      <div className="git-error-body">
        <div className="git-error-op">{tpl('操作：$__op__', { op })}</div>
        <pre>{text}</pre>
      </div>
    </Modal>
  )
}

export default GitErrorModal
