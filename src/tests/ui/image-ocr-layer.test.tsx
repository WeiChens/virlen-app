/**
 * 图片预览的「识别文字」层 —— 口径。
 *
 * 1. **默认不识别、不显示**：打开预览只显示图；设置 `imageOcrAutoPreview` 打开时才自动跑一次 OCR，
 *    否则点工具栏「识别文字」才开始（识别完文字层仍是收起的，再点一下才展开）；
 * 2. **只做 OCR**：走 `vision_ocr` / `vision_ocr_base64`，**不碰** `vision_analyze`；
 * 3. **每种状态都有话说**：识别中 / 没读出字 / 失败各一条提示，后两种带「重新识别」；
 * 4. **做过的不再算**：同一张图再打开不重复 IPC（进程内 memo；跨重启由 Rust 内容指纹缓存兜住），
 *    但**空结果不算「做过」** —— quasivision 会把引擎瞬时失败吞成空文本，不能缓存成永久结论；
 * 5. **重新识别要带 force**：否则 Rust 侧磁盘缓存原样把旧结果还回来。
 *
 * 真实推理 / 缓存语义在 Rust 用例里（`virlen-core/src/vision`），这里只验「接上了没有」。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ImageOcrLayer, {
  canOcr,
  hasOcrText,
  nextOcrAction,
} from '@/ui/components/shared/ImageOcr'
import ImagePreview, {
  showImagePreview,
} from '@/ui/components/shared/ImagePreview'
import { imageOcrMemo, useImageOcr } from '@/ui/hooks/useImageOcr'
import { settingsState } from '@/ui/store/settingStore'

const { ocrMock, ocrBase64Mock, analyzeMock, copyMock, toastMock, readBytesMock } = vi.hoisted(
  () => ({
    ocrMock: vi.fn(),
    ocrBase64Mock: vi.fn(),
    analyzeMock: vi.fn(),
    copyMock: vi.fn(),
    toastMock: vi.fn(),
    readBytesMock: vi.fn(),
  }),
)

vi.mock('@/infrastructure/vision', () => ({
  vision: {
    ocr: ocrMock,
    ocrBase64: ocrBase64Mock,
    analyze: analyzeMock,
    analyzeBase64: analyzeMock,
  },
  VisionError: class VisionError extends Error {},
}))

vi.mock('@/utils/clipboard', () => ({
  copyText: copyMock,
  readImageBytes: readBytesMock,
  imageMimeOf: () => 'image/png',
  bytesToBase64: () => 'QUJD',
  defaultImageName: () => 'image-1',
  copyImageToClipboard: vi.fn(),
  saveImageAs: vi.fn(),
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: toastMock }))

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLElement | null = null

function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return act(async () => {
    root!.render(node)
  })
}

/**
 * 用 hook 的最小宿主：`auto` 对应设置项，`initialVisible` 对应两处预览的「默认收起」。
 * `ocr-trigger` 复刻工具栏按钮的点击语义（`nextOcrAction` → start / toggle）。
 */
function Harness({
  src,
  path,
  auto = true,
  initialVisible = true,
}: {
  src: string
  path?: string
  auto?: boolean
  initialVisible?: boolean
}) {
  const ocr = useImageOcr({ src, path }, { auto })
  const [visible, setVisible] = useState(initialVisible)
  return (
    <div className="viewer">
      <button className="toggle" onClick={() => setVisible((v) => !v)}>
        toggle
      </button>
      <button
        className="ocr-trigger"
        onClick={() => {
          const next = nextOcrAction(ocr.state, visible)
          setVisible(next.visible)
          if (next.run) ocr.start()
        }}>
        ocr
      </button>
      <span className="has-text">{hasOcrText(ocr.state) ? 'yes' : 'no'}</span>
      <span className="can-ocr">{canOcr(ocr.state) ? 'yes' : 'no'}</span>
      <ImageOcrLayer state={ocr.state} visible={visible} onRetry={ocr.retry} />
    </div>
  )
}

const layerText = () => document.querySelector<HTMLElement>('.image-ocr-text')?.textContent
const statusText = () => document.querySelector<HTMLElement>('.image-ocr-status')?.textContent
const retryButton = () => document.querySelector<HTMLButtonElement>('.image-ocr-retry')
/** 点一下（用 act 包住并等微任务：点击会触发异步 OCR，不 await 会漏进下一个断言） */
const clickClass = (cls: string) =>
  act(async () => {
    document.querySelector<HTMLButtonElement>(`.${cls}`)!.click()
  })

beforeEach(() => {
  document.body.innerHTML = ''
  imageOcrMemo.clear()
  ocrMock.mockReset()
  ocrBase64Mock.mockReset()
  analyzeMock.mockReset()
  copyMock.mockReset()
  readBytesMock.mockReset()
  copyMock.mockResolvedValue(true)
  // 默认：不自动识别（与产品默认值一致）
  settingsState.setValue('imageOcrAutoPreview', false)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
})

describe('useImageOcr', () => {
  it('有本地路径就走路径命令，识别出的文本进文字层', async () => {
    ocrMock.mockResolvedValue({ text: '第一行\n第二行', cached: false })
    await render(<Harness src="blob:one" path="E:/ws/a.png" />)

    expect(ocrMock).toHaveBeenCalledWith('E:/ws/a.png', false)
    expect(ocrBase64Mock).not.toHaveBeenCalled()
    expect(layerText()).toBe('第一行\n第二行')
    expect(document.querySelector('.has-text')?.textContent).toBe('yes')
  })

  it('没有路径（消息里的 data URL）走 base64 命令，图片字节不落盘', async () => {
    ocrBase64Mock.mockResolvedValue({ text: '截图里的字', cached: false })
    await render(<Harness src="data:image/png;base64,AAAA" />)

    expect(ocrBase64Mock).toHaveBeenCalledWith('data:image/png;base64,AAAA', false)
    expect(ocrMock).not.toHaveBeenCalled()
    expect(layerText()).toBe('截图里的字')
  })

  it('从不调 vision_analyze（只做 OCR，不做视觉识别）', async () => {
    ocrMock.mockResolvedValue({ text: 'ok', cached: true })
    await render(<Harness src="blob:x" path="E:/ws/x.png" />)
    expect(analyzeMock).not.toHaveBeenCalled()
  })

  it('同一张图再打开不重复识别（进程内 memo）', async () => {
    ocrMock.mockResolvedValue({ text: '同一个字', cached: true })
    await render(<Harness src="blob:same" path="E:/ws/same.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(1)

    await act(async () => root?.unmount())
    await render(<Harness src="blob:same" path="E:/ws/same.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(1)
    expect(layerText()).toBe('同一个字')
  })

  it('失败不缓存：下次打开还会再试一次', async () => {
    ocrMock.mockRejectedValueOnce(new Error('models not found'))
    ocrMock.mockResolvedValue({ text: '第二次成功', cached: false })
    await render(<Harness src="blob:retry" path="E:/ws/retry.png" />)
    expect(statusText()).toContain('文字识别失败')

    await act(async () => root?.unmount())
    await render(<Harness src="blob:retry" path="E:/ws/retry.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(2)
    expect(layerText()).toBe('第二次成功')
  })

  it('空结果也当「没做过」：下次打开重新识别', async () => {
    ocrMock.mockResolvedValueOnce({ text: '', cached: false })
    ocrMock.mockResolvedValue({ text: '这次读出来了', cached: false })
    await render(<Harness src="blob:empty-retry" path="E:/ws/e.png" />)
    expect(statusText()).toContain('未识别到文字')

    await act(async () => root?.unmount())
    await render(<Harness src="blob:empty-retry" path="E:/ws/e.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(2)
    expect(layerText()).toBe('这次读出来了')
  })

  it('SVG 不识别（矢量图没有位图文字，识别必失败）', async () => {
    await render(<Harness src="data:image/svg+xml;utf8,<svg/>" />)
    expect(ocrMock).not.toHaveBeenCalled()
    expect(ocrBase64Mock).not.toHaveBeenCalled()
    expect(document.querySelector('.image-ocr-layer')).toBeNull()
    expect(document.querySelector('.image-ocr-status')).toBeNull()
    // 没有可识别的图：工具栏不该给按钮
    expect(document.querySelector('.can-ocr')?.textContent).toBe('no')
  })

  it('没读出字时给一句提示，并允许没有开关（hasOcrText = false）', async () => {
    ocrMock.mockResolvedValue({ text: '   ', cached: false })
    await render(<Harness src="blob:empty" path="E:/ws/empty.png" />)
    expect(statusText()).toContain('未识别到文字')
    expect(document.querySelector('.has-text')?.textContent).toBe('no')
    expect(document.querySelector('.image-ocr-layer')).toBeNull()
  })

  it('关掉「打开即识别」：打开不跑推理，点「识别文字」才开始', async () => {
    ocrMock.mockResolvedValue({ text: '点了才有的字', cached: false })
    await render(
      <Harness src="blob:manual" path="E:/ws/m.png" auto={false} initialVisible={false} />,
    )

    expect(ocrMock).not.toHaveBeenCalled()
    expect(document.querySelector('.image-ocr-status')).toBeNull()
    // 就绪状态仍要给按钮（否则用户没入口）
    expect(document.querySelector('.can-ocr')?.textContent).toBe('yes')

    await clickClass('ocr-trigger')
    expect(ocrMock).toHaveBeenCalledTimes(1)
    expect(layerText()).toBe('点了才有的字')
  })

  it('手动识别过的图再打开，点一下就出字（memo 命中，不再 IPC）', async () => {
    ocrMock.mockResolvedValue({ text: '缓存过的字', cached: true })
    await render(<Harness src="blob:m2" path="E:/ws/m2.png" auto={false} />)

    await act(async () => root?.unmount())
    await render(<Harness src="blob:m2" path="E:/ws/m2.png" auto={false} />)
    await clickClass('ocr-trigger')
    expect(ocrMock).toHaveBeenCalledTimes(1) // 只有第一次那轮真跑了
    expect(layerText()).toBe('缓存过的字')
  })
})

describe('ImageOcrLayer', () => {
  beforeEach(() => {
    imageOcrMemo.clear()
  })

  it('识别完文字层仍然收起（默认不显示识别文字）', async () => {
    ocrMock.mockResolvedValue({ text: '要展开才看得到的字', cached: false })
    await render(
      <Harness src="blob:hidden" path="E:/ws/h.png" initialVisible={false} />,
    )
    expect(document.querySelector('.has-text')?.textContent).toBe('yes')
    expect(document.querySelector('.image-ocr-layer')).toBeNull()

    // 展开后才有文本、才可能复制
    await clickClass('ocr-trigger')
    expect(layerText()).toBe('要展开才看得到的字')
  })

  it('开关能收起 / 展开文字层', async () => {
    ocrMock.mockResolvedValue({ text: '可收起的字', cached: false })
    await render(<Harness src="blob:t" path="E:/ws/t.png" />)

    await clickClass('toggle')
    expect(document.querySelector('.image-ocr-layer')).toBeNull()
    await clickClass('toggle')
    expect(layerText()).toBe('可收起的字')
  })

  it('「复制文字」把整段文本交给剪贴板', async () => {
    ocrMock.mockResolvedValue({ text: '一段文字', cached: false })
    await render(<Harness src="blob:c" path="E:/ws/c.png" />)

    await act(async () => document.querySelector<HTMLButtonElement>('.image-ocr-copy')!.click())
    expect(copyMock).toHaveBeenCalledWith('一段文字')
    expect(toastMock).toHaveBeenCalled()
  })

  it('「重新识别」带 force 重跑，能把被缓存的空结果救回来', async () => {
    // 第一次（引擎瞬时失败）返回空，且这次的空结果进了 Rust 缓存（历史行为）
    ocrMock.mockResolvedValueOnce({ text: '', cached: true })
    ocrMock.mockResolvedValue({ text: '重新读出来的字', cached: false })
    await render(<Harness src="blob:heal" path="E:/ws/heal.png" />)
    expect(statusText()).toContain('未识别到文字')

    await act(async () => retryButton()!.click())
    expect(ocrMock).toHaveBeenLastCalledWith('E:/ws/heal.png', true)
    expect(layerText()).toBe('重新读出来的字')
  })

  it('识别失败也挂着「重新识别」', async () => {
    ocrMock.mockRejectedValueOnce(new Error('Vision Error: boom'))
    ocrMock.mockResolvedValue({ text: '再来一次就好了', cached: false })
    await render(<Harness src="blob:err" path="E:/ws/err.png" />)
    expect(statusText()).toContain('文字识别失败')

    await act(async () => retryButton()!.click())
    expect(layerText()).toBe('再来一次就好了')
  })
})

describe('大图浮层里的接线', () => {
  async function openPreview(src: string) {
    await render(<ImagePreview />)
    await act(async () => showImagePreview({ src, previewSrcList: [src] }))
  }

  /** 工具栏里的「识别文字」按钮（按 title 找，避免依赖索引） */
  const ocrButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.image-preview-toolbar button')].find((el) =>
      el.getAttribute('title')?.includes('识别文字'),
    )

  it('默认（设置关）打开浮层不识别，按钮点了才识别并展开', async () => {
    ocrBase64Mock.mockResolvedValue({ text: '浮层里的字', cached: false })
    await openPreview('data:image/png;base64,AAAA')

    expect(ocrBase64Mock).not.toHaveBeenCalled()
    const button = ocrButton()
    expect(button).toBeTruthy()
    expect(button!.getAttribute('title')).toBe('识别文字')

    await act(async () => button!.click())
    expect(ocrBase64Mock).toHaveBeenCalledWith('data:image/png;base64,AAAA', false)
    expect(layerText()).toBe('浮层里的字')
    expect(ocrButton()!.getAttribute('title')).toBe('隐藏识别文字')
  })

  it('设置打开时自动识别，但文字层仍默认收起', async () => {
    settingsState.setValue('imageOcrAutoPreview', true)
    ocrBase64Mock.mockResolvedValue({ text: '自动识别出来的字', cached: false })
    await openPreview('data:image/png;base64,AAAA')

    expect(ocrBase64Mock).toHaveBeenCalledWith('data:image/png;base64,AAAA', false)
    // 识别完了，但默认不显示
    expect(document.querySelector('.image-ocr-layer')).toBeNull()
    expect(ocrButton()!.getAttribute('title')).toBe('显示识别文字')
    // 收起 = 普通按钮外观（不高亮）
    expect(ocrButton()!.classList.contains('is-active')).toBe(false)

    await act(async () => ocrButton()!.click())
    expect(layerText()).toBe('自动识别出来的字')
    // 文字真正显示出来时才是激活态
    expect(ocrButton()!.classList.contains('is-active')).toBe(true)
  })

  it('识别失败时浮层仍可用，并留着按钮可以重试', async () => {
    settingsState.setValue('imageOcrAutoPreview', true)
    ocrBase64Mock.mockRejectedValue(new Error('Vision Error: boom'))
    await openPreview('data:image/png;base64,BBBB')

    expect(statusText()).toContain('文字识别失败')
    expect(document.querySelector('.image-preview-overlay')).toBeTruthy()
    expect(ocrButton()!.getAttribute('title')).toBe('识别文字')
  })
})
