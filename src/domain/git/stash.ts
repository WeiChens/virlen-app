/**
 * 贮藏条目的**展示口径**（纯函数）—— 界面与测试都消费它。
 *
 * `git stash list` 回的是 reflog 消息原文，实测三种形态：
 * - 带 `-m`：`On <branch>: <消息>`；
 * - 不带（终端 / 别的工具）：`WIP on <branch>: <短 oid> <提交标题>`（git 自动生成）；
 * - 删除后撤销（`stash store -m`）恢复：**只有消息本身**，没有前缀。
 *
 * ⚠️ 解析**只用于展示**：条目身份是 oid —— `stash@{n}` 是列表位置，外部一次 push / drop 就会
 * 整体重编号（`pop` / `drop` 只认 stash ref，所以 selector 的解析在 Rust 侧、持锁完成）。
 */
import type { GitStashEntry } from './types'

export interface StashLabel {
  /** 贮藏时的分支名（解析不出来 → null；游离 HEAD 会是 `(no branch)` 这类字面值） */
  branch: string | null
  /** 展示用消息（没有 `-m` 的条目会退化成「短 oid + 提交标题」） */
  message: string
  /** 没有 `-m`：消息是 git 自动生成的 WIP 描述 */
  auto: boolean
}

const WIP_ON = /^WIP on (.*?): ([0-9a-f]{7,64}) (.*)$/s
const ON = /^On (.*?): (.*)$/s

/** reflog 消息 → 分支 + 消息（顺序：先认带 WIP 前缀的自动消息，再认我们自己的 `-m`） */
export function parseStashMessage(raw: string): StashLabel {
  const text = raw.trim()
  const wip = WIP_ON.exec(text)
  if (wip) {
    return { branch: wip[1], message: wip[3].trim(), auto: true }
  }
  const on = ON.exec(text)
  if (on) {
    return { branch: on[1], message: on[2].trim(), auto: false }
  }
  return { branch: null, message: text, auto: false }
}

/** 列表 / 确认框里的一句话（空消息给调用方传入的占位文案） */
export function stashSummary(entry: GitStashEntry, emptyLabel: string): string {
  const label = parseStashMessage(entry.message)
  return label.message || emptyLabel
}
