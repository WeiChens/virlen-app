/**
 * 图片预览的「识别文字」层 —— 口径。
 *
 * 1. **默认不识别、不显示**：打开预览只显示图；设置 `imageOcrAutoPreview` 打开时才自动跑一次 OCR，
 *    否则点工具栏「识别文字」才开始（识别完文字层仍是收起的，再点一下才展开）；
 * 2. **只做 OCR**：走 `vision_ocr` / `vision_ocr_base64`，**不碰** `vision_analyze`；
 * 3. **文字摆在原位且透明**：每个文本框一个绝对定位的 `<span>`（`left/top/width/height` = 框 ÷ 原图，
 *    字号 = 这一行的屏幕像素高）；摆不出位置（没有框 / EXIF 方向对不上）才退回纯文本面板；
 * 4. **每种状态都有话说**：识别中 / 没读出字 / 失败各一条提示，后两种带「重新识别」；
 * 5. **做过的不再算**：同一张图再打开不重复 IPC（进程内 memo；跨重启由 Rust 内容指纹缓存兜住），
 *    但**空结果不算「做过」** —— quasivision 会把引擎瞬时失败吞成空文本，不能缓存成永久结论；
 * 6. **重新识别要带 force**：否则 Rust 侧磁盘缓存原样把旧结果还回来；
 * 7. **跨行拖选粘出来是多行**：每行是独立的绝对定位元素，浏览器不补换行，`copy` 由文字层自己接管。
 *
 * 真实推理 / 缓存语义在 Rust 用例里（`virlen-core/src/vision`），这里只验「接上了没有」。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ImageOcrPlane, {
  canOcr,
  fitRatio,
  hasOcrText,
  ImageOcrOverlay,
  nextOcrAction,
  ocrRunStyle,
  ocrTextMenuItems,
  placedBoxes,
  lineSeparator,
  selectAllOcrText,
  selectedLinesText,
  type ImageOcrNatural,
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

/** 造一个 OCR 文本框（原图像素坐标） */
function box(text: string, x: number, y: number, w: number, h: number) {
  return { text, x, y, w, h }
}

/** 造一条「带框」的 OCR 结果：坐标系 200×100，一个框占了左上一半 */
function placedResult(text = '第一行', boxes = [box(text, 10, 20, 100, 20)]) {
  return { text, cached: false, boxes, width: 200, height: 100 }
}

/**
 * 用 hook 的最小宿主：`auto` 对应设置项，`initialVisible` 对应两处预览的「默认收起」。
 * `ocr-trigger` 复刻工具栏按钮的点击语义（`nextOcrAction` → start / toggle）。
 * `natural` 模拟 `<img>` 的 naturalWidth/Height（EXIF 校验用）。
 */
function Harness({
  src,
  path,
  auto = true,
  initialVisible = true,
  natural = null,
}: {
  src: string
  path?: string
  auto?: boolean
  initialVisible?: boolean
  natural?: ImageOcrNatural | null
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
      <div className="anchor">
        <ImageOcrPlane state={ocr.state} visible={visible} natural={natural} />
      </div>
      <ImageOcrOverlay
        state={ocr.state}
        visible={visible}
        natural={natural}
        onRetry={ocr.retry}
      />
    </div>
  )
}

/** 文字层里能读到的正文：定位层的每一行，或（摆不出位置时的）纯文本面板 */
const layerText = () => {
  const runs = [...document.querySelectorAll<HTMLElement>('.image-ocr-run')]
  if (runs.length) return runs.map((el) => el.textContent).join('\n')
  return document.querySelector<HTMLElement>('.image-ocr-panel-text')?.textContent
}
const runs = () => [...document.querySelectorAll<HTMLElement>('.image-ocr-run')]
/** 文字层有没有展开（定位层或退路面板都算） */
const layerShown = () => document.querySelector('.image-ocr-layer, .image-ocr-panel') !== null
const statusText = () => document.querySelector<HTMLElement>('.image-ocr-status')?.textContent
const barButton = (cls: string) =>
  document.querySelector<HTMLButtonElement>(`.image-ocr-bar .${cls}`)
const retryButton = () =>
  document.querySelector<HTMLButtonElement>('.image-ocr-retry')
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
    ocrMock.mockResolvedValue(placedResult('第一行'))
    await render(<Harness src="blob:one" path="E:/ws/a.png" />)

    expect(ocrMock).toHaveBeenCalledWith('E:/ws/a.png', false)
    expect(ocrBase64Mock).not.toHaveBeenCalled()
    expect(layerText()).toBe('第一行')
    expect(document.querySelector('.has-text')?.textContent).toBe('yes')
  })

  it('没有路径（消息里的 data URL）走 base64 命令，图片字节不落盘', async () => {
    ocrBase64Mock.mockResolvedValue(placedResult('截图里的字'))
    await render(<Harness src="data:image/png;base64,AAAA" />)

    expect(ocrBase64Mock).toHaveBeenCalledWith('data:image/png;base64,AAAA', false)
    expect(ocrMock).not.toHaveBeenCalled()
    expect(layerText()).toBe('截图里的字')
  })

  it('从不调 vision_analyze（只做 OCR，不做视觉识别）', async () => {
    ocrMock.mockResolvedValue(placedResult('ok'))
    await render(<Harness src="blob:x" path="E:/ws/x.png" />)
    expect(analyzeMock).not.toHaveBeenCalled()
  })

  it('同一张图再打开不重复识别（进程内 memo）', async () => {
    ocrMock.mockResolvedValue(placedResult('同一个字'))
    await render(<Harness src="blob:same" path="E:/ws/same.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(1)

    await act(async () => root?.unmount())
    await render(<Harness src="blob:same" path="E:/ws/same.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(1)
    expect(layerText()).toBe('同一个字')
  })

  it('失败不缓存：下次打开还会再试一次', async () => {
    ocrMock.mockRejectedValueOnce(new Error('models not found'))
    ocrMock.mockResolvedValue(placedResult('第二次成功'))
    await render(<Harness src="blob:retry" path="E:/ws/retry.png" />)
    expect(statusText()).toContain('文字识别失败')

    await act(async () => root?.unmount())
    await render(<Harness src="blob:retry" path="E:/ws/retry.png" />)
    expect(ocrMock).toHaveBeenCalledTimes(2)
    expect(layerText()).toBe('第二次成功')
  })

  it('空结果也当「没做过」：下次打开重新识别', async () => {
    ocrMock.mockResolvedValueOnce({ text: '', cached: false, boxes: [], width: 0, height: 0 })
    ocrMock.mockResolvedValue(placedResult('这次读出来了'))
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
    expect(layerShown()).toBe(false)
    expect(document.querySelector('.image-ocr-status')).toBeNull()
    // 没有可识别的图：工具栏不该给按钮
    expect(document.querySelector('.can-ocr')?.textContent).toBe('no')
  })

  it('没读出字时给一句提示，并允许没有开关（hasOcrText = false）', async () => {
    ocrMock.mockResolvedValue({ text: '   ', cached: false, boxes: [], width: 0, height: 0 })
    await render(<Harness src="blob:empty" path="E:/ws/empty.png" />)
    expect(statusText()).toContain('未识别到文字')
    expect(document.querySelector('.has-text')?.textContent).toBe('no')
    expect(layerShown()).toBe(false)
    // 「没读出字」是结论不是过程：不该挂着转圈
    expect(document.querySelector('.image-ocr-spinner')).toBeNull()
  })

  it('关掉「打开即识别」：打开不跑推理，点「识别文字」才开始', async () => {
    ocrMock.mockResolvedValue(placedResult('点了才有的字'))
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
    ocrMock.mockResolvedValue(placedResult('缓存过的字'))
    await render(<Harness src="blob:m2" path="E:/ws/m2.png" auto={false} />)

    await act(async () => root?.unmount())
    await render(<Harness src="blob:m2" path="E:/ws/m2.png" auto={false} />)
    await clickClass('ocr-trigger')
    expect(ocrMock).toHaveBeenCalledTimes(1) // 只有第一次那轮真跑了
    expect(layerText()).toBe('缓存过的字')
  })
})

describe('透明定位层', () => {
  beforeEach(() => {
    imageOcrMemo.clear()
  })

  it('每个文本框摆到原位置：百分比定位 + 字号 = 这一行的屏幕像素高', async () => {
    ocrMock.mockResolvedValue(placedResult('主人你好'))
    await render(<Harness src="blob:pos" path="E:/ws/p.png" />)

    const [run] = runs()
    expect(run).toBeTruthy()
    expect(run.textContent).toBe('主人你好')
    // 坐标系 200×100、框 (10,20,100,20) → 5% / 20% / 20%（厚度）
    expect(run.style.left).toBe('5%')
    expect(run.style.top).toBe('20%')
    // 沿阅读方向不钉死：让 span 箱子 = 文字自身宽度，才轮得到 scaleX 把「文字」校到框长
    expect(run.style.width).toBe('max-content')
    expect(run.style.height).toBe('20%')
    // 字号：20/100 × 100cqh = 20cqh（容器高 = 图片显示高，所以这就是屏上的像素高）
    expect(run.style.getPropertyValue('--ocr-line')).toBe('20cqh')
  })

  it('多个框各自一项（不合并成行），顺序跟随 Rust 的阅读顺序', async () => {
    ocrMock.mockResolvedValue(
      placedResult('Name Age\nAlice 30', [
        box('Name', 0, 0, 80, 20),
        box('Age', 120, 0, 60, 20),
        box('Alice', 0, 40, 80, 20),
        box('30', 120, 40, 60, 20),
      ]),
    )
    await render(<Harness src="blob:multi" path="E:/ws/multi.png" />)

    expect(runs().map((el) => el.textContent)).toEqual(['Name', 'Age', 'Alice', '30'])
  })

  it('竖排的框（高明显大于宽）走 vertical-rl，厚度取框宽', async () => {
    ocrMock.mockResolvedValue(
      placedResult('竖排文字', [box('竖排文字', 0, 0, 20, 80), box('横排', 40, 0, 80, 20)]),
    )
    await render(<Harness src="blob:vertical" path="E:/ws/v.png" />)

    expect(runs()[0].classList.contains('is-vertical')).toBe(true)
    expect(runs()[1].classList.contains('is-vertical')).toBe(false)
    // 竖排：宽度钉成框宽（10% of 200），长度方向 max-content，字号单位换成 cqw
    expect(runs()[0].style.width).toBe('10%')
    expect(runs()[0].style.height).toBe('max-content')
    expect(runs()[0].style.getPropertyValue('--ocr-line')).toBe('10cqw')
  })

  it('退化框（宽或高为 0）不摆到图上；全是退化框就退回纯文本面板', async () => {
    ocrMock.mockResolvedValue(
      placedResult('文字', [box('坏的', 0, 0, 0, 20), box('也是坏的', 0, 0, 10, 0)]),
    )
    await render(<Harness src="blob:degenerate" path="E:/ws/d.png" />)

    expect(runs()).toEqual([])
    expect(document.querySelector('.image-ocr-panel-text')?.textContent).toBe('文字')
  })

  it('EXIF 方向对不上（natural 与 OCR 坐标系不同）时不摆字，退回纯文本面板', async () => {
    ocrMock.mockResolvedValue(placedResult('手机照片里的字'))
    // 坐标系 200×100，浏览器按 EXIF 旋转后变成 100×200 → 宽高互换
    await render(
      <Harness
        src="blob:exif"
        path="E:/ws/rotated.jpg"
        natural={{ width: 100, height: 200 }}
      />,
    )

    expect(runs()).toEqual([])
    expect(document.querySelector('.image-ocr-panel-text')?.textContent).toBe('手机照片里的字')
    // 小条也要说明「已退回纯文本」，不能让人以为定位层坏了
    expect(document.querySelector('.image-ocr-bar-hint')?.textContent).toBe(
      '文字位置不可用，已退回纯文本',
    )
  })

  it('natural 与坐标系一致时正常摆字', async () => {
    ocrMock.mockResolvedValue(placedResult('正常照片'))
    await render(
      <Harness src="blob:same" path="E:/ws/n.jpg" natural={{ width: 200, height: 100 }} />,
    )
    expect(runs().length).toBe(1)
    expect(document.querySelector('.image-ocr-bar-hint')?.textContent).toBe(
      '已在图上定位文字，可直接选中复制',
    )
  })

  it('摆不出位置（老缓存没有框）时退回纯文本面板', async () => {
    ocrMock.mockResolvedValue({ text: '只有文本没有框', cached: true })
    await render(<Harness src="blob:nobox" path="E:/ws/nobox.png" />)

    expect(runs()).toEqual([])
    expect(document.querySelector('.image-ocr-panel-text')?.textContent).toBe('只有文本没有框')
  })
})

describe('ocrRunStyle / placedBoxes（纯函数）', () => {
  it('百分比换算按坐标系走，不依赖屏幕尺寸', () => {
    const style = ocrRunStyle(box('x', 300, 150, 600, 90), { width: 1200, height: 600 })
    expect(style).toMatchObject({
      left: '25%',
      top: '25%',
      width: 'max-content',
      height: '15%',
      '--ocr-line': '15cqh',
    })
  })

  it('竖排框：厚度取框宽（cqw），长度方向也交给校准', () => {
    const style = ocrRunStyle(box('x', 0, 0, 20, 80), { width: 200, height: 400 })
    expect(style).toMatchObject({
      left: '0%',
      top: '0%',
      width: '10%',
      height: 'max-content',
      '--ocr-line': '10cqw',
    })
  })

  it('坐标系为 0 时不产生 Infinity / NaN', () => {
    const style = ocrRunStyle(box('x', 0, 0, 10, 10), { width: 0, height: 0 })
    expect(style).toMatchObject({ left: '0%', top: '0%', '--ocr-line': '1000cqh' })
  })

  it('placedBoxes：没框 / 没尺寸 / 状态不是 done → null', () => {
    expect(placedBoxes({ status: 'ready' })).toBeNull()
    expect(placedBoxes({ status: 'done', text: 'x', boxes: [], size: { width: 10, height: 10 } })).toBeNull()
    expect(placedBoxes({ status: 'done', text: 'x', boxes: [box('x', 0, 0, 1, 1)], size: null })).toBeNull()
  })

  it('placedBoxes：EXIF 宽高互换 → null；一致 → 原样返回', () => {
    const state = {
      status: 'done' as const,
      text: 'x',
      boxes: [box('x', 0, 0, 10, 10)],
      size: { width: 200, height: 100 },
    }
    expect(placedBoxes(state, { width: 100, height: 200 })).toBeNull()
    expect(placedBoxes(state, { width: 200, height: 100 })?.boxes.length).toBe(1)
    // 拿不到 natural（还没 load 完）：不拦，照常摆
    expect(placedBoxes(state, null)?.boxes.length).toBe(1)
  })

  it('fitRatio：把渲染出来的文字长度校到框长（选中高亮不再比文字长一截）', () => {
    // 文字比框长（中文字宽 ≈ 1em，而 det 框贴的是图上真实字形）→ 压回去
    expect(fitRatio(300, 450)).toBe(0.6667)
    // 文字比框短 → 拉开
    expect(fitRatio(450, 300)).toBeCloseTo(1.5, 4)
    // 长度一致 → 不校正（1 = 不设 CSS 变量）
    expect(fitRatio(300, 300)).toBe(1)
    // 量不到（jsdom / 还没布局）→ 不校正
    expect(fitRatio(0, 300)).toBe(1)
    expect(fitRatio(300, 0)).toBe(1)
    // 量测抖动不该把字压成一条线
    expect(fitRatio(300, 1)).toBe(4)
    expect(fitRatio(1, 300)).toBe(0.25)
  })
})

describe('ImageOcrOverlay / 文字层开关', () => {
  beforeEach(() => {
    imageOcrMemo.clear()
  })

  it('识别完文字层仍然收起（默认不显示识别文字）', async () => {
    ocrMock.mockResolvedValue(placedResult('要展开才看得到的字'))
    await render(
      <Harness src="blob:hidden" path="E:/ws/h.png" initialVisible={false} />,
    )
    expect(document.querySelector('.has-text')?.textContent).toBe('yes')
    expect(layerShown()).toBe(false)
    expect(document.querySelector('.image-ocr-bar')).toBeNull()

    // 展开后才有文本、才可能复制
    await clickClass('ocr-trigger')
    expect(layerText()).toBe('要展开才看得到的字')
  })

  it('识别中：前面一颗转圈，后面是「正在识别文字」', async () => {
    let finish: (value: unknown) => void = () => {}
    ocrMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await render(<Harness src="blob:busy" path="E:/ws/busy.png" />)

    const chip = document.querySelector<HTMLElement>('.image-ocr-status')
    expect(chip?.textContent).toBe('正在识别文字…')
    const spinner = chip?.querySelector('.image-ocr-spinner')
    expect(spinner).toBeTruthy()
    // 转圈在文字**前面**
    expect(chip!.firstElementChild).toBe(spinner)

    // 识别完就不再有转圈
    await act(async () => finish(placedResult('识别完了')))
    expect(document.querySelector('.image-ocr-spinner')).toBeNull()
  })

  it('开关能收起 / 展开文字层', async () => {
    ocrMock.mockResolvedValue(placedResult('可收起的字'))
    await render(<Harness src="blob:t" path="E:/ws/t.png" />)

    await clickClass('toggle')
    expect(layerShown()).toBe(false)
    await clickClass('toggle')
    expect(layerText()).toBe('可收起的字')
  })

  it('「复制全部文字」把整段文本交给剪贴板', async () => {
    ocrMock.mockResolvedValue(placedResult('一段文字'))
    await render(<Harness src="blob:c" path="E:/ws/c.png" />)

    const button = barButton('image-ocr-copy')
    expect(button?.textContent).toBe('复制全部文字')
    await act(async () => button!.click())
    expect(copyMock).toHaveBeenCalledWith('一段文字')
    expect(toastMock).toHaveBeenCalled()
  })

  it('「重新识别」带 force 重跑，能把被缓存的空结果救回来', async () => {
    // 第一次（引擎瞬时失败）返回空，且这次的空结果进了 Rust 缓存（历史行为）
    ocrMock.mockResolvedValueOnce({ text: '', cached: true, boxes: [], width: 0, height: 0 })
    ocrMock.mockResolvedValue(placedResult('重新读出来的字'))
    await render(<Harness src="blob:heal" path="E:/ws/heal.png" />)
    expect(statusText()).toContain('未识别到文字')

    await act(async () => retryButton()!.click())
    expect(ocrMock).toHaveBeenLastCalledWith('E:/ws/heal.png', true)
    expect(layerText()).toBe('重新读出来的字')
  })

  it('识别失败也挂着「重新识别」', async () => {
    ocrMock.mockRejectedValueOnce(new Error('Vision Error: boom'))
    ocrMock.mockResolvedValue(placedResult('再来一次就好了'))
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
    ocrBase64Mock.mockResolvedValue(placedResult('浮层里的字'))
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
    ocrBase64Mock.mockResolvedValue(placedResult('自动识别出来的字'))
    await openPreview('data:image/png;base64,AAAA')

    expect(ocrBase64Mock).toHaveBeenCalledWith('data:image/png;base64,AAAA', false)
    // 识别完了，但默认不显示
    expect(layerShown()).toBe(false)
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

  it('图片与文字层在同一个变换锚点里（缩放/旋转时文字才会跟着走）', async () => {
    settingsState.setValue('imageOcrAutoPreview', true)
    ocrBase64Mock.mockResolvedValue(placedResult('跟着图走'))
    await openPreview('data:image/png;base64,CCCC')
    // 等自动识别的 Promise 落地，再点工具栏把文字层展开
    await act(async () => {})
    await act(async () => ocrButton()!.click())

    const anchor = document.querySelector('.image-preview-anchor')
    expect(anchor).toBeTruthy()
    expect(anchor!.querySelector('img.preview-image')).toBeTruthy()
    expect(anchor!.querySelector('.image-ocr-layer')).toBeTruthy()
    // 小条在容器里（不随图片旋转缩放），不在锚点里
    expect(anchor!.querySelector('.image-ocr-bar')).toBeNull()
    expect(document.querySelector('.image-preview-container .image-ocr-bar')).toBeTruthy()
  })
})

describe('跳行拖选复制（按几何补空格 / 换行）', () => {
  beforeEach(() => {
    imageOcrMemo.clear()
    document.getSelection()?.removeAllRanges()
  })

  /** 摆一个多行文字层：`boxes` 就是 OCR 框（原图像素），顺序即阅读顺序 */
  async function renderLines(boxes: ReturnType<typeof box>[]) {
    ocrMock.mockResolvedValue(placedResult(boxes.map((item) => item.text).join('\n'), boxes))
    await render(<Harness src="blob:copy-lines" path="E:/ws/copy.png" />)
    const els = runs()
    expect(els.length).toBe(boxes.length)
    els.forEach((el) => expect(el.firstChild).toBeTruthy())
    return els
  }

  /** 两行紧凑排版（竖直间隙 6、行厚 20 → 不空行） */
  const stacked = () => [box('Name', 0, 0, 120, 20), box('Alice', 0, 26, 120, 20)]
  /** 同一行的两个框（竖直方向完全重叠） */
  const sameRow = () => [box('Name', 0, 0, 80, 20), box('Age', 100, 0, 60, 20)]
  /** 段落之间空出一整行（间隙 80 ÷ 行厚 20 = 4 → 封顶 3 个空行） */
  const farApart = () => [box('上段', 0, 0, 120, 20), box('下段', 0, 100, 120, 20)]

  /** 从 `first` 的第 `start` 个字选到 `second` 的第 `end` 个字 */
  function selectAcross(
    first: HTMLElement,
    second: HTMLElement,
    start = 0,
    end = second.textContent!.length,
  ) {
    const range = document.createRange()
    range.setStart(first.firstChild!, start)
    range.setEnd(second.firstChild!, end)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }

  /** 模拟一次 Ctrl+C：派一个带 clipboardData 的 copy 事件到 document（监听就在那里） */
  function fireCopy() {
    const setData = vi.fn()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData } })
    document.dispatchEvent(event)
    return { setData, event }
  }

  const layer = () => document.querySelector<HTMLElement>('.image-ocr-layer')

  it('选了两行：行间补换行（浏览器原生拼不出换行，由文字层接管）', async () => {
    const [first, second] = await renderLines(stacked())
    selectAcross(first, second)

    expect(selectedLinesText(layer())).toBe('Name\nAlice')

    const { setData, event } = fireCopy()
    expect(setData).toHaveBeenCalledWith('text/plain', 'Name\nAlice')
    // 接管了就不能再让浏览器写一遍
    expect(event.defaultPrevented).toBe(true)
  })

  it('同一行的相邻框之间是空格（表格同一行 / det 把一行切成两个框）', async () => {
    const [first, second] = await renderLines(sameRow())
    selectAcross(first, second)
    expect(selectedLinesText(layer())).toBe('Name Age')
  })

  it('行距够宽就多空一行（间隙 ÷ 行厚 决定换几个）', async () => {
    const [first, second] = await renderLines(farApart())
    selectAcross(first, second)
    expect(selectedLinesText(layer())).toBe('上段\n\n\n\n下段')
  })

  it('只选了每行的一段：按几何拼，仍取选中的部分', async () => {
    const [first, second] = await renderLines(stacked())
    selectAcross(first, second, 2, 3) // 'me' + 'Ali'
    expect(selectedLinesText(layer())).toBe('me\nAli')
  })

  it('单行内拖选不带分隔符', async () => {
    const [first] = await renderLines(stacked())
    selectAcross(first, first, 1, 3)
    expect(selectedLinesText(layer())).toBe('am')
  })

  it('行上没有框坐标时退回「一行一个换行」', async () => {
    const [first, second] = await renderLines(sameRow())
    first.removeAttribute('data-ocr-box')
    selectAcross(first, second)
    expect(selectedLinesText(layer())).toBe('Name\nAge')
  })

  it('选区不在文字层里就不接管（复制别处的字照旧）', async () => {
    await renderLines(stacked())
    const outside = document.createElement('p')
    outside.textContent = '别处的字'
    document.body.appendChild(outside)

    const range = document.createRange()
    range.selectNodeContents(outside)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(selectedLinesText(layer())).toBe('')
    const { setData, event } = fireCopy()
    expect(setData).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('「全选」把整层选中，复制仍然带换行', async () => {
    const [, second] = await renderLines(stacked())
    expect(second).toBeTruthy()
    selectAllOcrText(layer())
    // 全选 = 每一行都整行选中 → 按几何拼出来就是完整的两行
    expect(selectedLinesText(layer())).toBe('Name\nAlice')
  })

  it('没有选区 / 没有层：返回空串（不改剪贴板）', () => {
    expect(selectedLinesText(null)).toBe('')
    expect(selectedLinesText(layer())).toBe('')
  })
})

describe('lineSeparator（按框几何决定空格还是换行）', () => {
  it('竖直重叠 > 75% 算同一行 → 一个空格', () => {
    expect(lineSeparator({ x: 0, y: 0, w: 80, h: 20 }, { x: 100, y: 0, w: 60, h: 20 })).toBe(' ')
    // 重叠 16/20 = 80%：高低错开一点仍然是一行
    expect(lineSeparator({ x: 0, y: 0, w: 80, h: 20 }, { x: 100, y: 4, w: 60, h: 20 })).toBe(' ')
  })

  it('重叠不足 75% 算下一行 → 换行', () => {
    expect(lineSeparator({ x: 0, y: 0, w: 80, h: 20 }, { x: 100, y: 10, w: 60, h: 20 })).toBe('\n')
    // 重叠 4/20 = 20%
    expect(lineSeparator({ x: 0, y: 0, w: 120, h: 20 }, { x: 0, y: 16, w: 120, h: 20 })).toBe('\n')
  })

  it('行间空隙 ÷ 行厚 决定空几行，最多 3 个', () => {
    // 间隙 6 / 行厚 20 = 0.3 → 一个换行
    expect(lineSeparator({ x: 0, y: 0, w: 120, h: 20 }, { x: 0, y: 26, w: 120, h: 20 })).toBe('\n')
    // 间隙 22 / 20 = 1.1 → 空一行
    expect(lineSeparator({ x: 0, y: 0, w: 120, h: 20 }, { x: 0, y: 42, w: 120, h: 20 })).toBe('\n\n')
    // 间隙 80 / 20 = 4 → 封顶 3 个空行
    expect(lineSeparator({ x: 0, y: 0, w: 120, h: 20 }, { x: 0, y: 100, w: 120, h: 20 })).toBe(
      '\n\n\n\n',
    )
  })

  it('竖排：同列上下算同一行（空格），并排两列算两行', () => {
    // 竖排框（高远大于宽）沿 x 排成列
    expect(lineSeparator({ x: 0, y: 0, w: 20, h: 80 }, { x: 0, y: 100, w: 20, h: 80 })).toBe(' ')
    expect(lineSeparator({ x: 20, y: 0, w: 20, h: 80 }, { x: 0, y: 0, w: 20, h: 80 })).toBe('\n')
  })

  it('只有两边都是竖排才按列比较，否则一律按竖直方向（横排口径）', () => {
    // 竖排框 + 横排框：按竖直方向比，两者竖直重叠 → 同一行
    expect(lineSeparator({ x: 0, y: 0, w: 20, h: 80 }, { x: 100, y: 0, w: 80, h: 20 })).toBe(' ')
    // 竖直方向接不上 → 换行
    expect(lineSeparator({ x: 0, y: 0, w: 20, h: 20 }, { x: 100, y: 20, w: 80, h: 20 })).toBe('\n')
  })
})

describe('ocrTextMenuItems（右键：复制 / 全选）', () => {
  it('复制：活选区 > 开菜单时的快照 > 全部文字', async () => {
    // 没有活选区时用快照（点菜单项那一刻选区多半已被折叠）
    await ocrTextMenuItems({ text: '全部文字', selection: '选中的半句' })[0].onClick()
    expect(copyMock).toHaveBeenLastCalledWith('选中的半句')

    // 连快照都没有 → 整段
    await ocrTextMenuItems({ text: '全部文字' })[0].onClick()
    expect(copyMock).toHaveBeenLastCalledWith('全部文字')
    expect(toastMock).toHaveBeenCalled()
  })

  it('给了全选动作就多一项，且保持菜单打开（好接着点复制）', () => {
    const withAll = ocrTextMenuItems({ text: 'x', onSelectAll: () => {} })
    expect(withAll.map((item) => item.label)).toEqual(['复制', '全选'])
    expect(withAll[1].keepOpen).toBe(true)
    // 没给 onSelectAll 就只给「复制」
    expect(ocrTextMenuItems({ text: 'x' }).map((item) => item.label)).toEqual(['复制'])
  })
})

describe('大图浮层：文字层右键菜单', () => {
  /** 在元素上右键（React 的 onContextMenu 监听的是 contextmenu 事件） */
  const rightClick = (el: Element) =>
    act(async () => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 30,
        }),
      )
    })

  const menuLabels = () =>
    [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent)
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
      (el) => el.textContent === label,
    )
  const clickItem = (label: string) =>
    act(async () => {
      menuItem(label)!.click()
    })

  /** 打开浮层 + 自动识别 + 展开文字层（两行：第一行 / 第二行） */
  async function openWithTwoLines() {
    settingsState.setValue('imageOcrAutoPreview', true)
    const boxes = [box('第一行', 0, 0, 120, 20), box('第二行', 0, 26, 120, 20)]
    ocrBase64Mock.mockResolvedValue(placedResult('第一行\n第二行', boxes))
    await render(<ImagePreview />)
    await act(async () =>
      showImagePreview({
        src: 'data:image/png;base64,DD',
        previewSrcList: ['data:image/png;base64,DD'],
      }),
    )
    // 等自动识别的 Promise 落地
    await act(async () => {})
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>('.image-preview-toolbar button'),
    ].find((el) => el.getAttribute('title')?.includes('识别文字'))
    await act(async () => button!.click())
    const els = runs()
    expect(els.length).toBe(2)
    return els
  }

  it('文字层里右键弹「复制 / 全选」，不再是图片菜单', async () => {
    const els = await openWithTwoLines()
    await rightClick(els[0])
    expect(menuLabels()).toEqual(['复制', '全选'])
  })

  it('选中两行后点「复制」= 选中的那两行（带换行）', async () => {
    const els = await openWithTwoLines()
    const range = document.createRange()
    range.setStart(els[0].firstChild!, 0)
    range.setEnd(els[1].firstChild!, 3)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    await rightClick(els[1])
    await clickItem('复制')
    expect(copyMock).toHaveBeenLastCalledWith('第一行\n第二行')
  })

  it('没选区时点「复制」= 整段文字', async () => {
    const els = await openWithTwoLines()
    document.getSelection()!.removeAllRanges()
    await rightClick(els[0])
    await clickItem('复制')
    expect(copyMock).toHaveBeenLastCalledWith('第一行\n第二行')
  })

  it('「全选」选中整层文字，之后复制照样带换行', async () => {
    const els = await openWithTwoLines()
    document.getSelection()!.removeAllRanges()
    await rightClick(els[0])
    await clickItem('全选')

    const selected = document.getSelection()!.toString()
    expect(selected).toContain('第一行')
    expect(selected).toContain('第二行')
    // 全选是 keepOpen：菜单还开着，可以接着点复制
    expect(menuItem('复制')).toBeTruthy()
    await clickItem('复制')
    expect(copyMock).toHaveBeenLastCalledWith('第一行\n第二行')
  })

  it('图片本体右键仍然是图片菜单（回归）', async () => {
    await openWithTwoLines()
    await rightClick(document.querySelector('.preview-image')!)
    expect(menuLabels()).toContain('另存为')
  })
})
