/**
 * vision_analyze 卡片展开视图 —— 「模型分析模式」必须能看到真正发给模型的那张图。
 *
 * 背景：关掉本地伪视觉分析后，工具结果（`role = tool`）里只有一段「图片事实」文本，
 * 图片本体在一条 `role = vision_image` 的注入消息里（列表不占行）。此前展开视图只渲染那段
 * 文本，用户没法确认「模型到底收到了哪张图」。现在工具结果带 `uiData.type = vision_image_sent`
 * + `imageMessageId`，展开视图按 id 取注入消息里的图渲染，并列出事实（含原图对照）。
 *
 * 本文件守五条：
 *   ① 模型分析模式：渲染 `<img>`（附件引用翻译成协议 URL），**不**再重复那段文本；
 *   ② 事实行：发出去那份的 mime / 宽高 / 字节，以及原图对照；
 *   ③ 注入消息晚于工具结果到达（本轮工具全跑完才 flush）时，图要**自动出现**（Observer 订阅）；
 *   ④ 图不在会话缓存里 → 给一行提示，不退回原始文本、不整块消失；
 *   ⑤ 本地伪视觉分析模式（无 uiData）行为不变：仍然是纯文本 tree text。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))

const { previewMock } = vi.hoisted(() => ({ previewMock: vi.fn() }))
vi.mock('@/ui/components/shared/ImagePreview', () => ({
  showImagePreview: previewMock,
}))

import VisionAnalyzeMessage from '@/ui/pages/chat/components/tool-call/VisionAnalyzeMessage'
import { addSessionMessage } from '@/services/chat/messages'
import { chatState, sessionStore } from '@/ui/store'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import type { Message, Session } from '@/types'

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HASH = 'a'.repeat(64)
/** 库里存的是内容寻址引用，渲染时才翻译成协议 URL（happy-dom 的用户代理不是 Windows） */
const IMAGE_REF = `attachment://${HASH}.png`
const IMAGE_PROTOCOL_URL = `virlen-attachment://localhost/${HASH}.png`
const ENVELOPE_TEXT = '🖼️ /w/shot.png\n📐 image/jpeg, 1568x1116 px, 2.0 KB'

const inst = new VisionAnalyzeMessage()
const created: string[] = []

const useContent: any = {
  id: 'tc1',
  name: 'vision_analyze',
  input: { path: '/w/shot.png' },
}

function toolResult(over: Record<string, any> = {}): Message {
  return {
    id: 'r1',
    role: 'tool',
    content: ENVELOPE_TEXT,
    toolCallId: 'tc1',
    uiData: {
      type: 'vision_image_sent',
      imageMessageId: 'img-1',
      path: '/w/shot.png',
      mediaType: 'image/jpeg',
      bytes: 2048,
      width: 1568,
      height: 1116,
      sourceMediaType: 'image/png',
      sourceBytes: 3276800,
      sourceWidth: 3840,
      sourceHeight: 2733,
    },
    timestamp: 1,
    ...over,
  } as Message
}

/** Rust 注入的那条图片消息（to 界面时已是外置引用） */
function imageMessage(): Message {
  return {
    id: 'img-1',
    role: 'vision_image',
    content: [
      { type: 'text', text: 'Image "shot.png" (/w/shot.png)' },
      { type: 'image_url', image_url: { url: IMAGE_REF, detail: 'auto' } },
    ],
    uiData: { type: 'vision_image', path: '/w/shot.png' },
    timestamp: 1,
  } as Message
}

function seed(messages: Message[]): string {
  const id = `s-vision-card-${created.length}-${Math.random().toString(36).slice(2, 8)}`
  const session: Session = {
    id,
    title: 't',
    messages,
    providerConfigId: '',
    modelId: '',
    systemPrompt: '',
    params: { ...DEFAULT_SESSION_PARAMS },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    tags: [],
  }
  sessionStore.saveSession(session)
  created.push(id)
  chatState.setValue('currentSessionId', id)
  return id
}

let host: HTMLDivElement
let root: Root

/** 与 tool-call/index.tsx 的 `ToolCallExpandView` 同构：在组件渲染里调 getExpandView */
function mount(message: Message): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(
      <div>
        {inst.getExpandView({ useContent, message, expand: true }) as any}
      </div>,
    )
  })
}

const img = () => host.querySelector('.vision-image-sent-img') as HTMLImageElement | null

beforeEach(() => {
  previewMock.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  chatState.setValue('currentSessionId', null)
  sessionStore.deleteSessions(created.splice(0))
})

describe('vision_analyze 展开视图（模型分析模式）', () => {
  it('渲染发给模型的那张图，fact + 原图对照，且不再重复文本结果', () => {
    seed([toolResult(), imageMessage()])
    mount(toolResult())

    expect(img()?.getAttribute('src')).toBe(IMAGE_PROTOCOL_URL)

    const facts = host.querySelector('.vision-image-sent-facts')!.textContent ?? ''
    expect(facts).toContain('发送给模型的图片')
    expect(facts).toContain('image/jpeg · 1568×1116 px · 2.0 KB')
    expect(facts).toContain('原图 image/png · 3840×2733 px · 3.1 MB')

    // 那段「图片事实」是给模型看的，模型模式下不再占展开视图
    expect(host.textContent).not.toContain('📐')
    expect(host.querySelector('pre')).toBeNull()
  })

  it('点图片开大图浮层', () => {
    seed([toolResult(), imageMessage()])
    mount(toolResult())

    act(() => {
      img()!.click()
    })
    expect(previewMock).toHaveBeenCalledWith({
      src: IMAGE_PROTOCOL_URL,
      previewSrcList: [IMAGE_PROTOCOL_URL],
    })
  })

  it('注入消息晚到（本轮工具全跑完才 flush）→ 图自动出现', () => {
    const id = seed([toolResult()])
    mount(toolResult())

    // 工具结果先到：此时会话里还没有那条注入消息
    expect(img()).toBeNull()
    expect(host.querySelector('.vision-image-sent-missing')).not.toBeNull()

    act(() => {
      addSessionMessage(id, imageMessage())
    })

    expect(img()?.getAttribute('src')).toBe(IMAGE_PROTOCOL_URL)
    expect(host.querySelector('.vision-image-sent-missing')).toBeNull()
    // 图到了也不退回文本
    expect(host.querySelector('pre')).toBeNull()
  })

  it('图不在会话缓存里 → 只给一行提示，facts 照旧', () => {
    seed([toolResult()])
    mount(toolResult())

    expect(img()).toBeNull()
    expect(host.querySelector('.vision-image-sent-missing')!.textContent).toContain(
      '图片未加载',
    )
    expect(host.querySelector('.vision-image-sent-facts')!.textContent).toContain(
      'image/jpeg',
    )
  })
})

describe('vision_analyze 展开视图（本地伪视觉分析模式）', () => {
  it('无 uiData → 行为不变，仍是纯文本 tree text', () => {
    seed([])
    mount(toolResult({ uiData: undefined, content: '[body] car [95%]' }))

    expect(host.querySelector('pre')!.textContent).toBe('[body] car [95%]')
    expect(img()).toBeNull()
  })
})
