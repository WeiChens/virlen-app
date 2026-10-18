/**
 * 贮藏消息的展示口径（`parseStashMessage` / `stashSummary`）。
 *
 * 三种形态都来自 `git stash list --format=%gs` 实测：
 * - 带 `-m`：`On <branch>: <消息>`；
 * - git 自动生成：`WIP on <branch>: <短 oid> <提交标题>`；
 * - `stash store -m` 恢复的条目：只有消息本身，没有前缀。
 *
 * ⚠️ 这里只测**展示**：条目身份是 oid，`stash@{n}` 的解析在 Rust 侧、持锁完成。
 */
import { expect, it } from 'vitest'
import { parseStashMessage, stashSummary } from '@/domain/git'

it('带 -m：拆出分支与消息（消息里再有冒号也只按最外层分）', () => {
  expect(parseStashMessage('On main: 修登录')).toEqual({
    branch: 'main',
    message: '修登录',
    auto: false,
  })
  expect(parseStashMessage('On feat/0914-responses-api: 修登录: 布局')).toEqual({
    branch: 'feat/0914-responses-api',
    message: '修登录: 布局',
    auto: false,
  })
})

it('自动生成：短 oid 不是消息（它只是「当时的 HEAD」），并标记 auto', () => {
  expect(parseStashMessage('WIP on feat/x: abc1234 初始提交')).toEqual({
    branch: 'feat/x',
    message: '初始提交',
    auto: true,
  })
})

it('没有前缀（stash store 恢复的条目）：整条都是消息，不编造分支', () => {
  expect(parseStashMessage('恢复的贮藏')).toEqual({
    branch: null,
    message: '恢复的贮藏',
    auto: false,
  })
})

it('用户消息本身就长得像 WIP：外层有 `On …: ` 前缀时不算自动生成', () => {
  expect(parseStashMessage('On main: WIP on main: abc1234 x')).toEqual({
    branch: 'main',
    message: 'WIP on main: abc1234 x',
    auto: false,
  })
})

it('空消息给占位（不留一条什么都没有的行）', () => {
  const entry = { oid: 'a'.repeat(40), message: '', time: '' }
  expect(stashSummary(entry, '（无贮藏信息）')).toBe('（无贮藏信息）')
})
