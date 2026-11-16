// @vitest-environment node
/**
 * 上下文**自动压缩** —— 判据与触发（`services/chat/auto-compress.ts`）。
 *
 * 为什么 mock `./flow` 与 `sessionRepo`：真实 `compressContext` 会拉起 Rust 引擎并落库，
 * 在单测里是噪音。本文件只回答四件事：
 *
 * 1. 开关默认**关** → 什么都不做（不许"顺手"压一下）；
 * 2. 占用未满（< 100% = 上下文窗口）→ 不压，哪怕开关打开；
 * 3. 占用已满 → 用**设置里的默认方式**压一次（不传 modeOverride）；
 * 4. 会话忙 / 暂停 / 正在压缩 → 不压（压缩会整体替换消息列表）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Session } from '@/types'

vi.mock('@/services/chat/flow', () => ({
  compressContext: vi.fn(async () => undefined),
}))

vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
}))

/** 库里尾部窗口的返回（本测试的“权威占用来源”） */
const dbPage: { messages: Message[]; hasMore: boolean; oldestRowid: number | null } = {
  messages: [],
  hasMore: false,
  oldestRowid: null,
}
vi.mock('@/infrastructure/sessionRepo', () => ({
  sessionRepo: {
    getMessagePage: vi.fn(async () => dbPage),
  },
}))

import { maybeAutoCompress } from '@/services/chat/auto-compress'
import { compressContext } from '@/services/chat/flow'
import { sessionStore, settingsState, updateSessionRuntime } from '@/ui/store'

const mockedCompress = vi.mocked(compressContext)
const DEFAULT_WINDOW = 200_000

function makeSession(id: string): Session {
  const now = Date.now()
  return {
    id,
    title: '会话',
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SP',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
  }
}

/** 一条带真实用量的助手消息（占用口径取 usage.totalTokens） */
function usageMessage(tokens: number): Message {
  return {
    id: `m-${tokens}`,
    role: 'assistant',
    content: 'hi',
    timestamp: Date.now(),
    usage: {
      promptTokens: tokens - 100,
      completionTokens: 100,
      totalTokens: tokens,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStore.saveSession(makeSession('s1'))
  settingsState.setValue('contextWindowTokens', DEFAULT_WINDOW)
  settingsState.setValue('contextAutoCompress', false)
  dbPage.messages = []
})

afterEach(() => {
  sessionStore.clear()
  settingsState.setValue('contextAutoCompress', false)
  settingsState.setValue('contextWindowTokens', DEFAULT_WINDOW)
})

describe('maybeAutoCompress —— 判据', () => {
  it('开关默认关：占用再满也不压', async () => {
    dbPage.messages = [usageMessage(DEFAULT_WINDOW * 2)]
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()
  })

  it('开关打开但占用未满（99%）→ 不压', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = [usageMessage(Math.floor(DEFAULT_WINDOW * 0.99))]
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()
  })

  it('开关打开 + 占用达到 100% → 用设置里的默认方式压一次', async () => {
    settingsState.setValue('contextAutoCompress', true)
    settingsState.setValue('contextCompressMode', 'raw')
    dbPage.messages = [usageMessage(DEFAULT_WINDOW)]
    expect(await maybeAutoCompress('s1')).toBe(true)
    // 第三个参数缺省 = 沿用设置（与点 token 环左键同形）
    expect(mockedCompress).toHaveBeenCalledTimes(1)
    expect(mockedCompress).toHaveBeenCalledWith('s1', undefined)
  })

  it('超过 100%（2 倍窗口）同样触发', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = [usageMessage(DEFAULT_WINDOW * 2)]
    expect(await maybeAutoCompress('s1')).toBe(true)
  })

  it('没有任何用量数据 → 不压（没有数据就不假设上下文满了）', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = []
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()
  })
})

describe('maybeAutoCompress —— 并发保护', () => {
  it('会话在跑 → 不压', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = [usageMessage(DEFAULT_WINDOW * 2)]
    updateSessionRuntime('s1', { working: true })
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()
    updateSessionRuntime('s1', { working: false })
  })

  it('暂停等回答 → 不压', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = [usageMessage(DEFAULT_WINDOW * 2)]
    updateSessionRuntime('s1', { paused: true })
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()
    updateSessionRuntime('s1', { paused: false })
  })

  it('正在压缩 → 不压（避免并发两次压缩）', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = [usageMessage(DEFAULT_WINDOW * 2)]
    updateSessionRuntime('s1', { compacting: true })
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()
    updateSessionRuntime('s1', { compacting: false })
  })
})

/**
 * 回归（真实踩到的 bug）：调用点曾经写成
 *
 *     finishWorking(...)          // 没 await
 *     void maybeAutoCompress(...)
 *
 * `finishWorking` 是 async，且 `working = false` 写在它的**第一个 await 之后**，
 * 于是自动压缩总是读到本轮的 `working = true`，一次也不会触发 ——
 * 表现为「开关开了、占用早就超过 100%，但就是不见压缩」。
 *
 * 这里锁的是**时序契约**：只有在 `finishWorking` 把 working 置回 false 之后才该压。
 */
describe('maybeAutoCompress —— 收尾时序（回归）', () => {
  it('本轮 working 未落地时（finishWorking 仍在 await 中）→ 不压；落地后才压', async () => {
    settingsState.setValue('contextAutoCompress', true)
    dbPage.messages = [usageMessage(DEFAULT_WINDOW * 2)]

    // 模拟 run 进行中：finishWorking 还没跑到 working=false 那一行
    updateSessionRuntime('s1', { working: true })
    expect(await maybeAutoCompress('s1')).toBe(false)
    expect(mockedCompress).not.toHaveBeenCalled()

    // finishWorking 收尾落地
    updateSessionRuntime('s1', { working: false })
    expect(await maybeAutoCompress('s1')).toBe(true)
    expect(mockedCompress).toHaveBeenCalledTimes(1)
  })
})
