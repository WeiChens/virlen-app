// @vitest-environment node
/**
 * 3D 预览的**异常日志**（`model-diagnostics.ts`）。四件事值得钉住：
 *
 * 1. **同一条只累加 `count`**：贴图是异步结算的（`watchTextures` 可能结算好几批），同一句
 *    警告不该把列表刷满；而 `params` / `detail` 变了就是另一件事，不能误合并。
 * 2. **上限**：超过 `MAX_DIAGNOSTICS` 丢最旧的（新问题比旧问题重要）。
 * 3. **两类贴图诊断的文案与阈值**：`found >= total` 一个字都不报；缺的名字最多列 6 个。
 * 4. **标题必须都在 `en-US.json` 里**（铁律 7）：新增一条诊断 = 加一行标题 + 加一条译文，
 *    漏了译文英文环境就会冒出中文。这里直接拿 `DIAGNOSTIC_TITLES` 逐条查，不靠正则扫源码。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  appendDiagnostic,
  budgetTextureDiagnostic,
  clockOf,
  countDiagnostics,
  DIAGNOSTIC_TITLES,
  droppedTextureDiagnostic,
  loadFailureDiagnostic,
  MAX_DIAGNOSTICS,
  textureDiagnostic,
  tooLargeTextureDiagnostic,
  type DiagnosticEntry,
  type DiagnosticInput,
} from '@/ui/pages/chat/components/workspace-file/model-diagnostics'

const DICT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/ui/i18n/lang/en-US.json'), 'utf8'),
) as Record<string, string>

function failure(code = 'x', detail = 'boom'): DiagnosticInput {
  return { level: 'error', code, title: DIAGNOSTIC_TITLES.parse, detail }
}

describe('日志条目', () => {
  it('追加：id 递增、count 从 1 起、time 用注入的 now', () => {
    const list = appendDiagnostic([], failure(), 1000)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 1,
      count: 1,
      time: 1000,
      level: 'error',
      detail: 'boom',
    })

    const more = appendDiagnostic(list, failure('y'), 2000)
    expect(more.map((entry) => entry.id)).toEqual([1, 2])
    expect(more[1].time).toBe(2000)
  })

  it('同一条只累加 count；detail 一变就是另一条', () => {
    let list = appendDiagnostic([], failure(), 1)
    list = appendDiagnostic(list, failure(), 2)
    expect(list).toHaveLength(1)
    expect(list[0].count).toBe(2)

    list = appendDiagnostic(list, failure('x', 'other'), 3)
    expect(list).toHaveLength(2)
  })

  it('params 不同的同名标题算两条（$__n__ 展开后才是同一件事）', () => {
    const two = droppedTextureDiagnostic(2)
    const three = droppedTextureDiagnostic(3)
    expect(two).not.toBeNull()
    expect(three).not.toBeNull()

    let list = appendDiagnostic(appendDiagnostic([], two!), three!)
    expect(list).toHaveLength(2)
    // 同样的 n 再来一次才是重复
    list = appendDiagnostic(list, two!)
    expect(list[0].count).toBe(2)
    expect(list[1].count).toBe(1)
  })

  it(`超过 ${MAX_DIAGNOSTICS} 条丢最旧的`, () => {
    let list: DiagnosticEntry[] = []
    for (let index = 0; index < MAX_DIAGNOSTICS + 5; index += 1) {
      list = appendDiagnostic(
        list,
        { level: 'warning', code: `c${index}`, title: DIAGNOSTIC_TITLES['texture-missing'] },
        index,
      )
    }
    expect(list).toHaveLength(MAX_DIAGNOSTICS)
    expect(list[0].code).toBe('c5')
    expect(list[list.length - 1].code).toBe(`c${MAX_DIAGNOSTICS + 4}`)
  })

  it('计数按条目分 error / warning（不按 count 累加）', () => {
    const list = appendDiagnostic(
      appendDiagnostic(appendDiagnostic([], failure()), failure()),
      { level: 'warning', code: 'w', title: DIAGNOSTIC_TITLES['texture-missing'] },
    )
    expect(countDiagnostics(list)).toEqual({ errors: 1, warnings: 1, total: 2 })
    expect(countDiagnostics([])).toEqual({ errors: 0, warnings: 0, total: 0 })
  })

  it('clockOf：HH:MM:SS 补零', () => {
    expect(clockOf(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05')
  })
})

describe('贴图两类诊断', () => {
  it('贴图缺失：只在 found < total 时报；名字最多 6 个，其余收成 +N', () => {
    expect(textureDiagnostic(3, 3)).toBeNull()
    expect(textureDiagnostic(0, 0)).toBeNull()
    expect(textureDiagnostic(1, 3, ['a.png', 'b.png'])).toMatchObject({
      level: 'warning',
      code: 'texture-missing',
      title: DIAGNOSTIC_TITLES['texture-missing'],
      detail: '1 / 3 · a.png, b.png',
    })

    const many = Array.from({ length: 9 }, (_, index) => `t${index}.png`)
    const issue = textureDiagnostic(0, 9, many)
    expect(issue?.detail).toContain('t5.png')
    expect(issue?.detail).not.toContain('t6.png')
    expect(issue?.detail).toContain('+3')
  })

  it('贴图过大 / 超预算：detail 带文件名与 MB（不翻译）', () => {
    expect(tooLargeTextureDiagnostic('a.png', 40 * 1024 * 1024)).toMatchObject({
      level: 'warning',
      code: 'texture-too-large',
      detail: 'a.png · 40.0 MB',
    })
    expect(budgetTextureDiagnostic('b.png', 1024 * 1024)).toMatchObject({
      code: 'texture-budget',
      detail: 'b.png · 1.0 MB',
    })
  })

  it('失效贴图槽：0 条不记（没动过就别写日志）', () => {
    expect(droppedTextureDiagnostic(0)).toBeNull()
    expect(droppedTextureDiagnostic(2)).toMatchObject({
      level: 'warning',
      params: { n: 2 },
      title: DIAGNOSTIC_TITLES['texture-dropped'],
    })
  })
})

describe('解析失败的标题', () => {
  it('只有「外部资源 / 不支持」有专门文案，其余都算解析失败', () => {
    expect(loadFailureDiagnostic('external-resources', 'x')).toMatchObject({
      level: 'error',
      code: 'load:external-resources',
      title: DIAGNOSTIC_TITLES['external-resources'],
      detail: 'x',
    })
    expect(loadFailureDiagnostic('unsupported', 'x').title).toBe(DIAGNOSTIC_TITLES.unsupported)
    expect(loadFailureDiagnostic(undefined, 'x')).toMatchObject({
      code: 'load:parse',
      title: DIAGNOSTIC_TITLES.parse,
    })
    // 库自己抛的异常（没有 code）：同样归「解析失败」，但不能和外部资源那条混成一条
    expect(loadFailureDiagnostic('weird', 'x').code).toBe('load:parse')
  })
})

describe('文案契约（铁律 7）', () => {
  it('每条诊断标题都在 en-US.json 里', () => {
    const missing = Object.values(DIAGNOSTIC_TITLES).filter((title) => !(title in DICT))
    expect(missing).toEqual([])
  })
})
