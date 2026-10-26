// @vitest-environment node
/**
 * 搜索源清单契约：TS（配置模板 + 工厂）↔ Rust（原生工具分发）必须是同一份清单。
 *
 * 为什么要有：37 个工具已全部原生化，真正跑的 `web_search` 在 Rust，它自己从 `app_settings`
 * 读搜索源配置、不经前端。只改 TS → 设置里能加，引擎永远回「未配置搜索源」；只改 Rust →
 * 设置里根本选不到。铁律 1 的两份镜像，这里用一张清单钉住（含默认地址与图标资源）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SEARCH_PROVIDER_TEMPLATES } from '@/domain/search/config'

function readProjectFile(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) {
    throw new Error(
      `本用例需要以 virlen-app 为工作目录运行：找不到 ${rel}（当前 cwd = ${process.cwd()}）`,
    )
  }
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

const CONFIG = readProjectFile('src/domain/search/config.ts')
const FACTORY = readProjectFile('src/infrastructure/search-providers/factory.ts')
const RUST = readProjectFile(
  'src-tauri/virlen-core/src/agent/native_tools/web/web_search.rs',
)

/** 模板表里登记的类型（`type: 'xxx',`；注释掉的行不算） */
function templateTypes(): string[] {
  return [
    ...new Set(
      [...CONFIG.matchAll(/^\s*type: '([a-z]+)',$/gm)].map((m) => m[1]),
    ),
  ]
}

/** 联合类型成员（`| 'xxx'`；`// | 'searxng'` 这种注释行匹配不到） */
function unionTypes(): string[] {
  const block =
    /export type SearchProviderType =([\s\S]*?)\n\n/.exec(CONFIG)?.[1] ?? ''
  return [...new Set([...block.matchAll(/^\s*\| '([a-z]+)'$/gm)].map((m) => m[1]))]
}

/** 工厂能实例化的类型 */
function factoryTypes(): string[] {
  return [...new Set([...FACTORY.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]))]
}

/** Rust 原生分发（`match cfg.provider_type.as_str()` 里的字符串分支，`_` 默认分支不算） */
function rustTypes(): string[] {
  const block =
    /match cfg\.provider_type\.as_str\(\) \{([\s\S]*?)\n    \};/.exec(RUST)?.[1] ??
    ''
  return [
    ...new Set([...block.matchAll(/^\s{8}"([a-z]+)" =>/gm)].map((m) => m[1])),
  ]
}

describe('搜索源清单：TS 模板 / 联合类型 / 工厂 / Rust 分发四处一致', () => {
  it('联合类型与模板表一一对应', () => {
    expect(new Set(unionTypes())).toEqual(new Set(templateTypes()))
  })

  it('模板类型工厂都能实例化', () => {
    expect(new Set(factoryTypes())).toEqual(new Set(templateTypes()))
  })

  it('Rust 原生分发与 TS 清单一致（少一个就是「设置能加、引擎说未配置」）', () => {
    expect(new Set(rustTypes())).toEqual(new Set(templateTypes()))
  })

  it('Rust 的默认地址兜底与模板的 defaultBaseUrl 逐个相同', () => {
    for (const tmpl of SEARCH_PROVIDER_TEMPLATES) {
      expect(RUST, `${tmpl.type} 缺默认地址兜底`).toContain(
        `"${tmpl.type}" => "${tmpl.defaultBaseUrl}".to_string()`,
      )
    }
  })

  it('模板图标资源真实存在且是图片（否则卡片是裂图）', () => {
    for (const tmpl of SEARCH_PROVIDER_TEMPLATES) {
      const file = resolve(process.cwd(), 'public', tmpl.icon.replace(/^\//, ''))
      expect(existsSync(file), `缺图标：${tmpl.icon}`).toBe(true)
      // 只查存在不够：抓图标时很容易抓到 404 的 HTML 页（真实的坑，字节数还很小）
      const b = readFileSync(file)
      const isIco = b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00
      const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      const isJpg = b[0] === 0xff && b[1] === 0xd8
      const head = b.subarray(0, 200).toString('utf8').trimStart()
      const isSvg = head.startsWith('<svg') || head.startsWith('<?xml')
      expect(isIco || isPng || isJpg || isSvg, `图标不是图片：${tmpl.icon}`).toBe(
        true,
      )
    }
  })

  it('DeepSeek 已接入（本轮的接入目标，别在重构里又掉队）', () => {
    expect(templateTypes()).toContain('deepseek')
    expect(rustTypes()).toContain('deepseek')
  })
})
