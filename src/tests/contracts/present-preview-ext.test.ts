// @vitest-environment node
/**
 * 「右侧面板能预览什么」是同一份知识，两处使用：
 * - TS 镜像 `src/domain/files/preview.ts`（面板判定 + present 的 JS 回退执行器）；
 * - Rust 清单 `src-tauri/virlen-core/src/agent/native_tools/file/preview_ext.json`
 *   （原生 present 的唯一判据，见 `preview_ext.rs`）。
 *
 * 本测试读 Rust 那份 JSON，逐条落到 TS 的 `previewKindOf` 上 —— 任一侧新增 / 删除扩展名而
 * 漏改另一侧，这里就红（present 的「不可预览就报错」才不会一边生效一边漏）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { previewKindOf, textPreviewKindOf } from '@/domain/files/preview'

const SOURCE = 'src-tauri/virlen-core/src/agent/native_tools/file/preview_ext.json'

/** JSON 里的分类名 → `previewKindOf` 的返回值（`textPreview` 单列，它落回 `text`） */
const KIND_OF_GROUP: Record<string, string> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  pdf: 'pdf',
  document: 'document',
  sheet: 'sheet',
  model: 'model',
}

interface PreviewExtFile {
  previewable: Record<string, string[]>
  notPreviewable: string[]
}

const file = JSON.parse(readFileSync(SOURCE, 'utf8')) as PreviewExtFile

describe('present 的可预览清单（Rust）↔ 面板判定（TS）', () => {
  it('previewable 的每个扩展名，面板判定都是对应类型', () => {
    for (const [group, exts] of Object.entries(file.previewable)) {
      for (const ext of exts) {
        const name = `sample.${ext}`
        if (group === 'textPreview') {
          expect(previewKindOf(name), `${name} 应按文本打开`).toBe('text')
          expect(textPreviewKindOf(name), `${name} 应有预览形态`).not.toBeNull()
        } else {
          expect(previewKindOf(name), `${name} 应为 ${group}`).toBe(KIND_OF_GROUP[group])
        }
      }
    }
  })

  it('notPreviewable 里不与 previewable 重叠的扩展名，面板判定为 other', () => {
    const previewableExts = new Set(Object.values(file.previewable).flat())
    // 已知唯一重叠：obj 既是 3D 模型又是 MSVC 目标文件 —— 两处清单都注明「模型优先」
    expect(file.notPreviewable.filter((ext) => previewableExts.has(ext))).toEqual(['obj'])
    for (const ext of file.notPreviewable) {
      if (previewableExts.has(ext)) continue
      expect(previewKindOf(`sample.${ext}`), `sample.${ext} 应不可预览`).toBe('other')
    }
  })

  it('工具描述里点名的「不支持」类型确实不可预览（描述与清单不许分叉）', () => {
    for (const ext of ['odt', 'ods', 'odp', 'zip', 'exe', 'ttf', 'psd', 'sqlite']) {
      expect(previewKindOf(`sample.${ext}`), `sample.${ext} 应不可预览`).toBe('other')
    }
  })
})
