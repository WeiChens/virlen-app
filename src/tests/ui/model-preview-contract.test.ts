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
const MESHES = read('src/ui/pages/chat/components/workspace-file/model-meshes.ts')

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

  it('取景只算全部网格（不跟隐藏状态走），「只看可见」只在 focusVisible 里', () => {
    const body = /private subjectBox\(([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    // 默认 `visibleOnly = false`：取景一旦跟着隐藏状态走，「重置视图」就会把整棵树重排一遍，
    // 模型逐步离开地面（实测：单独显示后显示全部 → 模型沉进地板）
    expect(body).toContain('visibleOnly = false')
    expect(body).toContain('visibleOnly && !isVisibleInTree(')
  })

  it('「单独显示」只动相机、不动模型变换（否则模型离开地面且回不去）', () => {
    // 只认方法签名（注释里也提到过 `focusVisible()`，不锚定就会匹配到注释里那颗花括号）
    const body = /  focusVisible\(\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(body).toContain('subjectBox(object, true)')
    // 机位交给 `moveCamera`（飞行），而不是直接往 `camera.position` 上写
    expect(body).toContain('moveCamera(')
    expect(body).not.toContain('this.camera.position.copy')
    // 模型变换一概不碰：缩放 / 位置是「加载时摆进画面」的一次性动作
    expect(body).not.toContain('object.scale')
    expect(body).not.toContain('object.position')
    expect(VIEW).toContain('focusVisible(')
    // 挑网格不许再调 `frameObject()`（那个会重排整棵树）：注释里提到它没关系，调用不许有
    expect(VIEW).not.toContain('?.frameObject()')
  })

  it('换机位要飞过去（单独显示 ↔ 显示全部），不许硬切', () => {
    // 相机移动只此一条通路：两个方向各写一套 `camera.position.copy()` 时切换就是一帧跳变
    expect(SCENE).toMatch(/private moveCamera\(/)
    expect(SCENE).toContain('CAMERA_FLIGHT_MS')
    // 插值必须落在每帧（`lerpVectors` + 缓入缓出），并且飞行没结束时循环要继续出帧
    expect(SCENE).toContain('this.camera.position.lerpVectors(')
    expect(SCENE).toMatch(/if \(this\.flight\) this\.stepFlight\(delta\)/)
    expect(SCENE).toMatch(/this\.interacting \|\|\r?\n\s*this\.flight \|\|/)
    // 两个方向都走飞行
    const reset = /  resetView\(\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(reset).toContain('frameObject(true)')
    // 加载完成那次仍同步落位（模型是一次性摆进来的，镜头再飘过去看着像没加载完）
    expect(SCENE).toContain('this.frameObject()')
    // 用户一按轨道就把手感交回去，不能从手上抢镜头
    expect(SCENE).toMatch(/this\.flight = null\r?\n\s*this\.interacting = true/)
  })

  it('选中高亮是独立对象（BoxHelper），不改模型材质（材质是共享的，改一处连带一片）', () => {
    expect(SCENE).toContain('new THREE.BoxHelper(')
    expect(SCENE).toContain('selectMesh(')
  })

  it('非选中的网格退成半透明（只在一处换材质：线框与半透明共用同一批替身）', () => {
    const body = /private applyMaterials\(\)[^{]*\{([\s\S]*?)\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(body).toContain('transparent = true')
    expect(body).toContain('DIM_OPACITY')
    // 不关深度写入：透明网格会互相挡成一团
    expect(body).toContain('depthWrite = false')
    // 否则两种效果各自换 material，会把对方的替身盖掉、原件漏成没人释放
    expect(SCENE).not.toContain('applyWireframe')
  })

  it('地面下沉 0.001（与网格线、模型底面共面会闪）', () => {
    expect(SCENE).toMatch(/const GROUND_Y = -0\.001/)
    expect(SCENE).toMatch(/this\.ground\.position\.y = GROUND_Y/)
    // 网格线不能跟着沉：地面是不透明的，压到它下面的网格线会整块看不见
    expect(SCENE).not.toMatch(/this\.grid\.position\.y/)
  })

  it('地面还要在深度里压后一档（纯几何让开在画面远端压不住）', () => {
    // 深度精度随距离平方衰减：near 0.01 / far 5000 时 20 单位处一个深度步长已到 2.4e-3，
    // 比那 0.001 的几何偏移还大 —— 只能靠多边形偏移（单位是「本像素最小可分辨深度差」）
    expect(SCENE).toContain('polygonOffset: true')
    expect(SCENE).toContain('polygonOffsetUnits: 4')
    // near 越小精度越差；0.05 在 `controls.minDistance = 0.2` 之下，不会近裁模型
    expect(SCENE).toContain('new THREE.PerspectiveCamera(50, width / height, 0.05, 5000)')
  })

  it('坐标轴要够长、且反方向也要有（`AxesHelper` 只画 +x/+y/+z）', () => {
    // 1.2 在取景后的模型（最长边 2.5）旁边几乎看不见
    expect(SCENE).toMatch(/const AXES_SIZE = 5/)
    expect(SCENE).toContain('new THREE.AxesHelper(AXES_SIZE)')
    // 反方向靠镜像缩放补一份
    expect(SCENE).toContain('this.axesNegative.scale.set(-1, -1, -1)')
    // ⚠️ 深度测试不许关：关了就直接画在模型前面（遮挡关系优先于「六根全露」）
    expect(SCENE).not.toContain('negativeAxisMaterial.depthTest')
    // 默认不显示：两边（面板 state 与场景）必须同步关，否则一开就“自己冒出来”
    expect(VIEW).toMatch(/showAxes: false/)
    expect(SCENE).toMatch(/showAxes: false/)
    const body = /  setAxes\(on: boolean\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(body).toContain('this.axesNegative.visible = on')
    expect(SCENE).toContain('this.axesNegative.dispose()')
  })

  it('换场景预设要淡过去（颜色 / 灯光 / 曝光插值 + 网格新旧对淡）', () => {
    expect(SCENE).toContain('PRESET_FADE_MS')
    // 起点快照读**当前实际值**：中途再切一次才能从半路接上（读预设表会先跳回去）
    expect(SCENE).toMatch(/from: this\.currentLook\(\), to: lookOf\(preset\)/)
    // 逐帧推进，且过渡期间循环要继续出帧
    expect(SCENE).toMatch(/if \(this\.lookFade\) this\.stepLookFade\(delta\)/)
    expect(SCENE).toMatch(/this\.lookFade \|\|\r?\n\s*this\.gridFade \|\|/)
    // 网格配色烘在顶点色里：改色只能重建，所以新旧两份对淡（不能硬换）
    expect(SCENE).toContain('this.startGridFade(')
    expect(SCENE).not.toContain('rebuildGrid(')
    // applyPreset 里不许再直接写颜色 / 强度（全部走插值）
    const body = /  applyPreset\(preset: ModelPreset\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(body).not.toContain('.color.set(')
    expect(body).not.toContain('toneMappingExposure')
  })

  it('移动模式是自建走位（不沿用轨道公转）：WASD/EQ 平移、拖动只转视线', () => {
    // 开关在「更多」菜单里，面板 state 与场景两侧都要有
    expect(VIEW).toMatch(/moveMode: false/)
    expect(VIEW).toContain("t('移动模式')")
    expect(VIEW).toContain('setMoveMode(')
    const body = /  setMoveMode\(on: boolean\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    // 轨道必须让位：它的拖动是绕 target 公转，不是「转头看」；极角也要放开，否则抬头被吞掉
    expect(body).toContain('this.controls.enabled = !on')
    expect(body).toContain('maxPolarAngle')
    // 键盘挂 window（画布不可聚焦），退出 / 卸载都要把键放掉
    expect(body).toContain("addEventListener('keydown'")
    expect(SCENE).toContain('this.detachMoveKeys()')
    expect(SCENE).toContain('this.moveKeys.clear()')
    // 走位必须相机与 target 一起挪：只挪相机，下一帧就被 `controls.update()` 拽回去
    const step =
      /  private stepMove\(delta: number\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(step).toContain('this.camera.position.add(move)')
    expect(step).toContain('this.controls.target.add(move)')
    // 水平面走位（竖直交给 Q/E），且不许钻到地面以下
    expect(step).toContain('forward.y = 0')
    expect(step).toContain('MOVE_MIN_Y')
    // 走位速度 = 主体最长边 / 2 每秒（模型大就快、小就慢），不许退回「视距 × 系数」
    const moveSpeed = /  private moveSpeed\(\): number \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(moveSpeed).toContain('this.subjectLength / MOVE_SPEED_DIVISOR')
    // 按住一直加速：每 1 秒加 `MOVE_ACCEL_PER_SECOND` 倍基础速度，**没有「全速」这一档**；
    // 松手 / 抵消 / 失焦都要归零，不清则下次一按就带着上次的加速度
    expect(step).toContain('MOVE_ACCEL_PER_SECOND')
    expect(step).toContain('this.moveHeld += delta')
    expect(step).not.toContain('Math.min(this.moveHeld') // 不许再给加速封顶
    expect(SCENE).toContain('this.moveHeld = 0')
    // 只按 A/D（左右平移）不加速，也不攒加速进度
    const accel = /const accelerating =([\s\S]*?)if \(accelerating\)/.exec(step)?.[1] ?? ''
    expect(accel).toContain("has('w')")
    expect(accel).toContain("has('q')")
    expect(accel).not.toContain("has('a')")
    expect(accel).not.toContain("has('d')")
    expect(step).toContain('else this.moveHeld = 0')
    expect(SCENE).not.toContain('MOVE_SPEED_PER_DISTANCE')
    expect(step).toContain('this.moveSpeed()')
    // 轨道关掉后它的滚轮缩放也失效：移动模式自己接一路（否则想拉近只能一直按 W）
    expect(SCENE).toContain("addEventListener('wheel', this.onMoveWheel")
    expect(SCENE).toContain("removeEventListener('wheel', this.onMoveWheel")
    const wheel =
      /  private onMoveWheel = \(event: WheelEvent\): void => \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    // 同时滚面板 / 页面就变成两件事了
    expect(wheel).toContain('event.preventDefault()')
    // 视距与轨道同一套限制，切回轨道不会突然弹一下
    expect(wheel).toContain('this.controls.minDistance')
    // 飞行期间不接管（落点是飞行算的），其余每帧推进
    expect(SCENE).toMatch(/else if \(this\.moveMode\) this\.stepMove\(delta\)/)
    // 转视角只动 target（相机不动），不另存 yaw / pitch
    const look =
      /  private lookBy\(dx: number, dy: number\): void \{([\s\S]*?)\r?\n  \}/.exec(SCENE)?.[1] ?? ''
    expect(look).toContain('this.controls.target.copy(this.camera.position).add(offset)')
    expect(look).not.toContain('camera.quaternion')
  })

  it('关掉选中模式即置空选中；再点同一块 = 取消选中', () => {
    // 高亮框 / 半透明 / 详情卡都挂在「选中」上，模式关掉还留着就是一堆不能再操作的残留
    // 换行符给 `\r?\n`：仓库在 Windows 下检出是 CRLF，写死 `\n` 在 CI（LF）与本地只有一边能过
    expect(VIEW).toMatch(/if \(options\.selectionMode\) return\r?\n\s*setSelectedMeshId\(null\)/)
    expect(VIEW).toContain('onSelectMesh(row.id === selectedMeshId ? null : row.id)')
    // 画布点选同一口径：点已选中的那一块 = 取消
    expect(SCENE).toContain('hit.object === this.selected ? null : hitId')
  })
})

describe('加载视觉 · 样式契约', () => {
  it('转圈必须提升成独立合成层（解析期间主线程被占住，否则动画停住 = 看起来像卡死）', () => {
    const rule = /\.wfp-spinner\s*\{([^}]*)\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('animation: wfp-spin')
    expect(rule).toContain('will-change: transform')
  })

  it('加载中就露场景、模型解析完才出现（画布不藏，旧模型先清掉）', () => {
    // 以前靠 `visibility: hidden` 藏画布；现在加载期间就要看到空舞台的网格 / 坐标轴
    expect(SCSS).not.toContain('.wfp-model-canvas.is-loading')
    expect(VIEW).not.toContain('is-loading')
    // 开新一份前先清掉上一份：否则加载期间画面里还是旧模型
    expect(VIEW).toContain('scene.clearModel()')
  })

  it('网格列表面板只能盖在舞台上（做成 flex 兄弟节点，面板一开画布就矮一大截）', () => {
    const rule = /\.wfp-mesh-panel\s*\{([^}]*)\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('position: absolute')
    // 底色只给 85%：盖在模型上要透出一点画面，否则整个左上角就是一块死板
    expect(rule).toContain('color-mix(')
    expect(rule).toContain('85%')
  })

  it('选中详情压在右下角（不能挂在列表下面：几百行时永远看不到它）', () => {
    const rule = /\.wfp-mesh-detail\s*\{([^}]*)\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('right: 8px')
    expect(rule).toContain('bottom: 8px')
  })

  it('眼睛图标必须是线条（`App.css` 的全局 `svg { fill }` 会盖掉 `fill="none"` 属性）', () => {
    const rule = /\.wfp-mesh-eye\s*\{([\s\S]*?)\n\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('fill: none')
    expect(rule).toContain('stroke: currentColor')
  })

  it('树形列表：层级来自场景发的父级链，行由纯函数展开（面板不自己走三遍对象树）', () => {
    // 分组 id 按遍历顺序发：折叠态与整组显隐都靠它，重取一次必须是同一批
    expect(SCENE).toContain('MESH_PARENT_ID_PREFIX')
    expect(SCENE).toContain('this.ancestorsOf(')
    // 无名组也要留一层：过滄掉会把树抹平一层（子网格直接挂到祖父下面）
    expect(SCENE).not.toContain('if (node.name) names.unshift')
    expect(MESHES).toContain('export function buildMeshRows')
    expect(MESHES).toContain('export function defaultCollapsedGroups')
    expect(MESHES).toContain('export function withGroupVisibility')
    expect(VIEW).toContain('buildMeshRows(meshes, collapsedGroups)')
    expect(VIEW).toContain('defaultCollapsedGroups(nextMeshes)')
    // 分组行只在网格行前多一个箭头；缩进跟着数据里的层级（`row.depth`）
    expect(VIEW).toContain('wfp-mesh-row wfp-mesh-group')
    expect(VIEW).toContain('row.depth * 12')
  })

  it('复制的是层级路径而不是兑底显示名（`path` 出了面板能对回模型层级）', () => {
    expect(VIEW).toContain('copyText(entry.path)')
    expect(VIEW).not.toContain('copyText(meshLabelOf(')
  })

  it('折叠箭头也必须是线条（与眼睛同一条理由，全局 `svg { fill }` 会盖掉属性）', () => {
    const rule = /\.wfp-mesh-twist\s*\{([\s\S]*?)\n\}/.exec(SCSS)?.[1] ?? ''
    expect(rule).toContain('fill: none')
    expect(rule).toContain('stroke: currentColor')
    // 展开态的角度只在 CSS 里一份（tsx 不再写一份角度）
    expect(SCSS).toMatch(/&\.is-open svg\s*\{[^}]*rotate\(90deg\)/)
  })

  it('低频开关与截图收进「更多」菜单（面板最窄 360px，十来个文字按钮会折成两行）', () => {
    const body =
      /function moreItems\(\): ContextMenuItem\[\] \{([\s\S]*?)\r?\n  \}/.exec(VIEW)?.[1] ?? ''
    for (const label of [
      "t('移动模式')",
      "t('网格')",
      "t('坐标轴')",
      "t('自动旋转')",
      "t('模型灯光')",
      "t('截图')",
    ]) {
      expect(body, `${label} 不在「更多」菜单里`).toContain(label)
    }
    expect(VIEW).toContain('toggleMoreMenu')
    expect(VIEW).toContain('aria-haspopup="menu"')
  })

  it('单独显示状态下详情卡的按钮就地变成「显示全部」（面板关着也退得回去）', () => {
    // 同一颗按钮：`isolatedId` 非空就显示「显示全部」并走 `onShowAllMeshes`
    expect(VIEW).toContain("isolatedId ? t('显示全部') : t('单独显示')")
    expect(VIEW).toContain('onShowAllMeshes')
  })

  it('没有异常就不渲染日志入口（没内容可看就不留图标）', () => {
    expect(VIEW).toMatch(/\{counts\.total > 0 && \(/)
  })
})
