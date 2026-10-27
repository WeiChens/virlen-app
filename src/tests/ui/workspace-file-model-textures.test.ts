// @vitest-environment node
/**
 * 3D 预览的**本地贴图**（`model-textures.ts`）：FBX 里写的是相对路径、面板却只有一个文件的字节
 * —— 这条链路得自己去模型目录把贴图读出来。三件事值得钉住：
 *
 * 1. **扫得准**：二进制 FBX 的字符串后面紧跟着下一个节点名（实测 `textures\heli.png` 后面还有
 *    `lv` 两个字节），扫出来的路径不能带着这截尾巴；
 * 2. **找得到**：导出机上的绝对路径（`\helicopter\textures\x.png`）、引用里的 `..`、
 *    被改了名的贴图文件夹，三种都要命中；
 * 3. **换得对**：`urlFor` 只换认得的；`data:` / `blob:` / `http(s):` 一个字不动（内嵌贴图与
 *    网络贴图不能被打断）；`dispose` 把造出来的 blob URL 全放掉，且可重复调用。
 *
 * 全部走注入的假 IO：真链路要 Tauri 的 `plugin-fs` 与真磁盘，那属于面板的端到端验证。
 */
import { describe, expect, it } from 'vitest'
import {
  baseNameOf,
  dirOf,
  loadModelTextures,
  normalizePath,
  scanTexturePaths,
  textureMimeOf,
  texturePathCandidates,
  type TextureDirEntry,
  type TextureFileIo,
} from '@/ui/pages/chat/components/workspace-file/model-textures'

const encoder = new TextEncoder()

/**
 * 造一段「二进制 FBX 味道」的字节：真实文件里字符串前面是长度字节、后面紧跟下一个节点的名字，
 * 所以扫到的值后面一定粘着别的可打印字节（末尾那两个 `lv` 就是给这条用例准备的）。
 */
function binaryFbxWith(reference: string): Uint8Array {
  const header = Uint8Array.from([0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x00, 0x1a, 0x00])
  const label = encoder.encode('RelativeFilename')
  const value = encoder.encode(reference)
  return Uint8Array.from([
    ...header,
    0x01,
    ...label,
    value.length,
    ...value,
    // 下一个节点的长度前缀 + 名字的前两个字节
    0x01,
    0x0e,
    0x6c,
    0x76,
  ])
}

interface FakeDisk {
  /** 规范化小写路径 → 字节 */
  files: Record<string, Uint8Array>
  /** 规范化小写目录 → 条目名（目录以 `/` 结尾） */
  dirs?: Record<string, string[]>
}

function fakeIo(disk: FakeDisk) {
  const created: string[] = []
  const revoked: string[] = []
  const io: TextureFileIo = {
    async read(path) {
      return disk.files[normalizePath(path).toLowerCase()] ?? null
    },
    async list(path): Promise<TextureDirEntry[] | null> {
      const names = disk.dirs?.[normalizePath(path).toLowerCase()]
      if (!names) return null
      return names.map((name) => ({
        name: name.replace(/\/$/, ''),
        directory: name.endsWith('/'),
      }))
    },
    createUrl(_bytes, mime) {
      const url = `blob:tex-${created.length}-${mime}`
      created.push(url)
      return url
    },
    revoke(url) {
      revoked.push(url)
    },
  }
  return { io, created, revoked }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('扫模型字节里的贴图路径', () => {
  it('二进制 FBX：名字后面的节点字节不算进去', () => {
    expect(scanTexturePaths(binaryFbxWith('textures\\heli_albedo_1024.png'))).toEqual([
      'textures\\heli_albedo_1024.png',
    ])
  })

  it('ASCII FBX / DAE：引号与标签是边界，扩展名大小写不敏感', () => {
    const text = [
      'RelativeFilename: "textures/heli_albedo_1024.png",',
      'FileName: "C:/work/heli/textures/heli_albedo_1024.png",',
      '<init_from>../tex/normal.JPG</init_from>',
      // 下面的都不是贴图，一个都不该进来
      'SourceAsset: "helicopter_textured.blend", "scene.bin", "material.mtl"',
    ].join('\n')
    // ⚠️ 盘符的 `:` 不是文件名字节（否则会把 ASCII FBX 的 `RelativeFilename:` 也吃进去），
    // 所以 `C:/work/…` 扫出来是 `/work/…`：少一个「别的机器上的盘符」正是想要的，
    // 候选路径本来就会逐段折掉开头的目录（空段被丢掉）
    expect(scanTexturePaths(encoder.encode(text))).toEqual([
      'textures/heli_albedo_1024.png',
      '/work/heli/textures/heli_albedo_1024.png',
      '../tex/normal.JPG',
    ])
  })

  it('同一个引用写了很多遍只留一条（FBX 里每个材质节点都会重复一次）', () => {
    const reference = encoder.encode('RelativeFilename"textures/a.png"RelativeFilename"textures/a.png"')
    expect(scanTexturePaths(reference)).toEqual(['textures/a.png'])
  })

  it('没有引用时是空数组（GLB / 纯几何格式的常态）', () => {
    expect(scanTexturePaths(encoder.encode('no textures here'))).toEqual([])
  })
})

describe('路径工具', () => {
  it('normalizePath：统一分隔符、吃掉 . 与 ..，盘符与开头斜杠保留', () => {
    expect(normalizePath('C:\\a\\b\\..\\c')).toBe('C:/a/c')
    expect(normalizePath('/a/./b//c')).toBe('/a/b/c')
    expect(normalizePath('a/b/../../c')).toBe('c')
    expect(normalizePath('a/b/../..')).toBe('')
  })

  it('baseNameOf / dirOf：两种分隔符都认', () => {
    expect(baseNameOf('C:\\proj\\textures\\a.png')).toBe('a.png')
    expect(baseNameOf('textures/a.png')).toBe('a.png')
    expect(dirOf('C:\\proj\\heli.fbx')).toBe('C:/proj')
    expect(dirOf('heli.fbx')).toBe('')
  })

  it('textureMimeOf：tga / dds 也要给对（blob 的类型）', () => {
    expect(textureMimeOf('a.PNG')).toBe('image/png')
    expect(textureMimeOf('a.jpeg')).toBe('image/jpeg')
    expect(textureMimeOf('a.tga')).toBe('image/x-tga')
    expect(textureMimeOf('a.dds')).toBe('image/vnd-ms.dds')
    expect(textureMimeOf('a.unknown')).toBe('application/octet-stream')
  })
})

describe('一个引用在磁盘上可能是哪几个路径', () => {
  it('导出机上的绝对路径：逐段折掉开头的目录（尾部往往正是真实位置）', () => {
    expect(
      texturePathCandidates('C:/proj/helicopter', '\\helicopter\\textures\\heli_albedo_1024.png'),
    ).toEqual([
      'C:/proj/helicopter/helicopter/textures/heli_albedo_1024.png',
      'C:/proj/helicopter/textures/heli_albedo_1024.png',
      'C:/proj/helicopter/heli_albedo_1024.png',
    ])
  })

  it('引用里的 .. 按词法解析（贴图放在上一层很常见）', () => {
    expect(texturePathCandidates('C:/proj/models', '../textures/a.png')).toEqual([
      'C:/proj/textures/a.png',
      'C:/proj/models/textures/a.png',
      'C:/proj/models/a.png',
    ])
  })

  it('同一个候选只出现一次（大小写不敏感）', () => {
    const candidates = texturePathCandidates('C:/proj', 'a.png')
    expect(candidates).toEqual(['C:/proj/a.png'])
  })
})

describe('把贴图读成 blob URL', () => {
  /** 用户的真实形状：FBX 在 `helicopter/`，贴图在 `helicopter/textures/` */
  function helicopterDisk() {
    return fakeIo({
      files: { 'c:/proj/helicopter/textures/heli_albedo_1024.png': PNG },
    })
  }

  const modelBytes = Uint8Array.from([
    ...binaryFbxWith('textures\\heli_albedo_1024.png'),
    ...binaryFbxWith('\\helicopter\\textures\\heli_albedo_1024.png'),
  ])

  it('两种写法都指向同一个文件：只读一次，按文件名 / 按相对路径都能换', async () => {
    const { io, created } = helicopterDisk()
    const textures = await loadModelTextures(
      modelBytes,
      'C:/proj/helicopter/helicopter_textured.fbx',
      io,
    )
    expect(textures).not.toBeNull()
    // 同一张图两个引用 → 只算一张，也只读一次
    expect(textures?.found).toBe(1)
    expect(textures?.total).toBe(1)
    expect(created).toHaveLength(1)
    expect(textures?.extensions.has('png')).toBe(true)
    // FBXLoader 只留文件名；DAE / 3DS 可能给全路径
    expect(textures?.urlFor('heli_albedo_1024.png')).toBe(created[0])
    expect(textures?.urlFor('textures/heli_albedo_1024.png')).toBe(created[0])
    expect(textures?.urlFor('HELI_ALBEDO_1024.PNG')).toBe(created[0])
  })

  it('内嵌 / 网络 / 认不出来的 URL 原样返回（不能打断 three 自己的路）', async () => {
    const { io } = helicopterDisk()
    const textures = await loadModelTextures(modelBytes, 'C:/proj/helicopter/a.fbx', io)
    for (const url of [
      'data:image/png;base64,AAAA',
      'blob:http://localhost/abc',
      'https://cdn.example.com/skin.png',
      'missing.png',
      '',
    ]) {
      expect(textures?.urlFor(url)).toBe(url)
    }
  })

  it('dispose：造出来的 blob URL 全放掉，重复调用不会重复撤销', async () => {
    const { io, created, revoked } = helicopterDisk()
    const textures = await loadModelTextures(modelBytes, 'C:/proj/helicopter/a.fbx', io)
    textures?.dispose()
    textures?.dispose()
    expect(revoked).toEqual(created)
  })

  it('内嵌贴图不算「外部贴图」：requested 只数 loader 按磁盘路径来问的', async () => {
    const { io, created } = helicopterDisk()
    const textures = await loadModelTextures(modelBytes, 'C:/proj/helicopter/a.fbx', io)
    // FBX 的嵌入贴图直接给 data:/blob:，不过路径改写 → 不能算进「引用」里
    expect(textures?.urlFor('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(textures?.requested).toBe(0)
    // 按文件名来问之后，统计切到「loader 真正要的」那一档
    expect(textures?.urlFor('heli_albedo_1024.png')).toBe(created[0])
    expect(textures?.requested).toBe(1)
    expect(textures?.found).toBe(1)
    expect(textures?.total).toBe(1)
  })

  it('引用路径全落空时按文件名在模型目录里找（贴图文件夹被改名）', async () => {
    const { io, created } = fakeIo({
      files: { 'c:/proj/helicopter/assets/heli.png': PNG },
      dirs: {
        'c:/proj/helicopter': ['assets/', 'helicopter.fbx'],
        'c:/proj/helicopter/assets': ['heli.png', 'unused.png'],
      },
    })
    const textures = await loadModelTextures(
      binaryFbxWith('textures\\heli.png'),
      'C:/proj/helicopter/helicopter.fbx',
      io,
    )
    expect(textures?.found).toBe(1)
    expect(created).toHaveLength(1)
    // 只读被点名的那张，目录里的其它图不碰
    expect(textures?.urlFor('heli.png')).toBe(created[0])
    expect(textures?.urlFor('unused.png')).toBe('unused.png')
  })

  it('模型字节里没有贴图引用 / 没有磁盘路径：直接不接管', async () => {
    const { io } = helicopterDisk()
    expect(await loadModelTextures(encoder.encode('nothing'), 'C:/proj/a.fbx', io)).toBeNull()
    expect(await loadModelTextures(modelBytes, '', io)).toBeNull()
    // 只有文件名（没有目录）也判不了同目录在哪
    expect(await loadModelTextures(modelBytes, 'a.fbx', io)).toBeNull()
  })

  it('引用了但磁盘上一张都没有：仍然报数量（面板要能说「贴图 0 / 1」）', async () => {
    const { io, created } = fakeIo({ files: {} })
    const textures = await loadModelTextures(modelBytes, 'C:/proj/helicopter/a.fbx', io)
    expect(textures?.found).toBe(0)
    expect(textures?.total).toBe(1)
    // 一张都没读到：不造 URL，URL 改写一个字不动（模型退化成纯色，但照画）
    expect(created).toHaveLength(0)
    expect(textures?.urlFor('heli_albedo_1024.png')).toBe('heli_albedo_1024.png')
    textures?.dispose()
  })
})
