// @vitest-environment node
/**
 * 3D 模型预览 · 构建与加载契约（都是编译期不报、只在运行时才出问题的四条）。
 *
 * ① **`optimizeDeps.exclude` 必须排除 DRACOLoader / KTX2Loader**：两者靠模块内
 *    `new URL('../libs/…', import.meta.url)` 定位解码器；被预打包后那几行会被重写成
 *    `/node_modules/.vite/libs/…`（**那个目录不存在**）—— dev 下 Draco 压过的 glb
 *    静默解不出来，且报的是 wasm 解析错，很难归因（Vite 自己的报错才提示加这个 exclude）。
 * ② **不许调 `setDecoderPath` / `setTranscoderPath`**：three 的默认值已经指向随包的 gltf / basis
 *    资产；改成字符串路径会让 DRACOLoader 额外去下 500KB 的 `draco_decoder.js` 兜底，
 *    还得再约定「我们把解码器搬到哪了」。
 * ③ **`model-loaders.ts` 里 three 只能是类型导入**：一旦变成值导入，主包就会带上整个 three。
 * ④ **`model-view.tsx` 只能动态 import 场景与加载器**：静态 import 同样会把 three 塞进主包
 *    （`model-presets.ts` 是纯数据，静态引是刻意的 —— 下拉框不能等 three 下载完才画）。
 * ⑤ **转圈要 `will-change: transform`、藏画布只能用 `visibility`**：前者不提升合成层的话，
 *    解析 glb 占住主线程期间动画会停（看起来像卡死）；后者换成 `display: none` 会让
 *    `ModelScene` 量到 0 宽高从而永不渲染（与容器 §11.54 同一条口径）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

const VITE_CONFIG = read('vite.config.ts')
const LOADERS = read('src/ui/pages/chat/components/workspace-file/model-loaders.ts')
const VIEW = read('src/ui/pages/chat/components/workspace-file/model-view.tsx')
const SCSS = read('src/ui/pages/chat/components/workspace-file/style.scss')
const SCENE = read('src/ui/pages/chat/components/workspace-file/model-scene.ts')

/** 顶层静态 import（`await import('…')` 这种动态引入不算） */
function staticImports(source: string): { clause: string; from: string }[] {
  const found: { clause: string; from: string }[] = []
  const pattern = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) found.push({ clause: match[1], from: match[2] })
  return found
}

describe('模型预览 · 构建契约', () => {
  it('optimizeDeps.exclude 排除 DRACO / KTX2 两个 loader（dev 下解码器路径才不会被预打包改写）', () => {
    const exclude = /exclude:\s*\[([\s\S]*?)\]/.exec(VITE_CONFIG)?.[1] ?? ''
    expect(exclude).toContain('three/examples/jsm/loaders/DRACOLoader.js')
    expect(exclude).toContain('three/examples/jsm/loaders/KTX2Loader.js')
  })

  it('不再自己搬解码器资源（three 自带的 new URL 已由打包器 emit 成资产）', () => {
    expect(VITE_CONFIG).not.toMatch(/virlen-three-assets/)
    expect(VITE_CONFIG).not.toMatch(/function\s+threeAssets/)
    expect(VITE_CONFIG).not.toContain('threeAssets()')
    expect(LOADERS).not.toMatch(/\.setDecoderPath\s*\(/)
    expect(LOADERS).not.toMatch(/\.setTranscoderPath\s*\(/)
  })
})

describe('模型预览 · 懒加载契约', () => {
  it('加载器注册表里 three 只做类型导入', () => {
    const imports = staticImports(LOADERS)
    const fromThree = imports.filter((item) => item.from === 'three')
    expect(fromThree.length).toBeGreaterThan(0)
    // 每一条都必须是 `import type … from 'three'`
    expect(fromThree.every((item) => item.clause.startsWith('type'))).toBe(true)
  })

  it('预览组件只动态引场景 / 加载器（静态引只有纯数据的预设）', () => {
    const imports = staticImports(VIEW)
    const heavy = imports.filter(
      (item) => /^\.\/model-(scene|loaders)$/.test(item.from) && !item.clause.startsWith('type'),
    )
    expect(heavy).toEqual([])
    expect(VIEW).toContain("await import('./model-scene')")
    expect(VIEW).toContain("await import('./model-loaders')")
    expect(imports.some((item) => item.from === './model-presets')).toBe(true)
  })
})

describe('模型预览 · 取景与灯光契约', () => {
  it('取景走主体包围盒（星空 / 远景散布会撑爆整棵树包围盒）', () => {
    expect(SCENE).toContain('subjectSpan(')
  })

  it('取包围盒前先刷矩阵（Box3.setFromObject 读的是父级 matrixWorld）', () => {
    const body = /private subjectBox\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(SCENE)?.[1] ?? ''
    const updateAt = body.indexOf('updateMatrixWorld(true)')
    const boxAt = body.indexOf('new THREE.Box3().setFromObject')
    expect(updateAt).toBeGreaterThan(-1)
    expect(boxAt).toBeGreaterThan(updateAt)
  })

  it('模型自带 punctual 灯默认不开（强度按作者场景尺度标注，缩放后必过曝）', () => {
    expect(VIEW).toMatch(/useModelLights: false/)
    expect(VIEW).toContain('setModelLights(')
  })
})

describe('加载视觉 · 样式契约', () => {
  it('转圈必须提升成独立合成层（解析期间主线程被占住，否则动画停住 = 看起来像卡死）', () => {
    const rule = /\.wfp-spinner\s*\{([^}]*)\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('animation: wfp-spin')
    expect(rule).toContain('will-change: transform')
  })

  it('模型解析中藏画布只能靠 visibility（display: none 会让 ModelScene 量到 0 从而永不渲染）', () => {
    const rule = /\.wfp-model-canvas\.is-loading\s*\{([^}]*)\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('visibility: hidden')
    expect(rule).not.toContain('display: none')
  })
})
