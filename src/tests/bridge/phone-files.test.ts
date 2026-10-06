/**
 * 手机端文件浏览 / 上传的**电脑侧回归**（§37）—— 接的是真实 bridge 装配，
 * 只把两件本机资源换成内存版：文件系统端口与安全校验。
 *
 * 盯住的七件事（协议包与手机端各有自己的用例，这里只管电脑侧）：
 * 1. **越权只有一道防线**：手机传来的 `..` 先被规整，再由 `resolvePath` 决定死活；
 *    安全拒绝必须是 `E_DENIED`（而不是「电脑端内部错误」，后者会让用户去重试、去报修）；
 * 2. **非中继门槛**：确认走了 TURN 中继 → 所有文件方法 `E_DENIED` + 同一句中文；
 *    `unknown` 放行（同源联调 / 非 WebRTC 链路必须进得来）；`abort` 是唯一的清理例外；
 * 3. **ACL 独立生效**：链路能力集里没有 `file.upload` 时上传被拒，且**根本不碰磁盘**；
 * 4. **分块与上限**：单块被夹到 `FILE_CHUNK_BYTES`；乱序 / 超申报大小 / 超限文件一律拒；
 * 5. **上传是原子的**：`finish` 之前磁盘上只有临时文件（`.virlen-part`），
 *    用户的目标目录里绝不会出现半截文件；
 * 6. **未传完的 `finish` 不丢临时态**：补完剩下几块后仍能收尾（否则弱网下一断就得从头传）；
 * 7. **覆写（编辑保存）与上传是两条路**：原地替换（不产生「 - 副本」）、必须带打开时的版本、
 *    版本不符就拒（**包括落盘前那一次**），且它归 `file.edit` 这一档授权。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  FILE_CHUNK_BYTES,
  FILE_DIRECT_ONLY_MESSAGE,
  FILE_EDIT_MAX_BYTES,
  FILE_UPLOAD_MAX_BYTES,
  base64ToBytes,
  bytesToBase64,
  createCaller,
  createMemoryPair,
  type FileListResult,
  type FileReadResult,
  type FileWriteBeginResult,
  type FileWriteFinishResult,
  type HostApi,
} from 'virlen-remote'
import { startPhoneBridge, type Capability, type FileSystemPort, DEFAULT_CAPABILITIES } from '@/bridge'
import { sessionStore } from '@/ui/store'
import type { Session } from '@/types'

const WORKSPACE = 'E:/ws'
const SESSION_ID = 's-1'

/**
 * 一个带工作目录的会话。
 *
 * ⚠️ **用真实的 `sessionStore`** 而不是把「工作目录从哪来」也做成注入口：文件接口层能看到的
 * 目录全由这一条链决定（`sessionStore.workspace` → `sessionWorkspaceOf` → `resolvePath`），
 * 把它换掉就等于把「手机的相对路径到底落在哪个目录」这件事从用例里删掉了。
 */
function makeSession(id: string, workspace: string): Session {
  const now = Date.now()
  return {
    id,
    title: '手机端文件用例',
    messages: [],
    providerConfigId: 'p-openai',
    modelId: 'gpt-4o',
    systemPrompt: 'system',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    workspace,
  }
}

/* ───────────────────────── 内存文件系统端口 ───────────────────────── */

interface MemoryFs extends FileSystemPort {
  /** 当前磁盘上的路径（排序后，便于断言「临时文件到底有没有落盘」）。 */
  paths(): string[]
  /** 读回一个文件的字节（缺失 → null）。 */
  read(path: string): Uint8Array | null
  /** 模拟「电脑上有人改了它」（会换掉 mtime）—— 编辑保存的冲突校验就靠这个差异。 */
  touch(path: string, content: string | Uint8Array): void
}

/** 相对名 → 绝对路径（端口收到的永远是绝对路径，与真机一致）。 */
function abs(relPath: string): string {
  return `${WORKSPACE}/${relPath}`
}

function createMemoryFs(initial: Record<string, string | Uint8Array> = {}): MemoryFs {
  const encoder = new TextEncoder()
  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, typeof content === 'string' ? encoder.encode(content) : content)
  }

  /**
   * 修改时刻（ms）—— 编辑保存的版本凭据。
   *
   * 用单调计数器而不是裸 `Date.now()`：同毫秒内连续两次写入必须给出**不同**的 mtime，
   * 否则「保存一次之后再保存」会因为没有差异而假通过。
   */
  const mtimes = new Map<string, number>()
  let mtimeSeq = 0
  const stamp = (path: string): void => {
    mtimeSeq = Math.max(Date.now(), mtimeSeq + 1)
    mtimes.set(path, mtimeSeq)
  }
  for (const path of files.keys()) stamp(path)

  /** 目录 = 「有以它开头的路径」且自身不是文件（根恒存在）。 */
  const isDir = (path: string): boolean => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    for (const key of files.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  return {
    async listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const seen = new Map<string, { name: string; isDir: boolean; size: number }>()
      for (const [path, bytes] of files) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash < 0) seen.set(rest, { name: rest, isDir: false, size: bytes.length })
        else {
          const name = rest.slice(0, slash)
          if (!seen.has(name)) seen.set(name, { name, isDir: true, size: 0 })
        }
      }
      return [...seen.values()]
    },
    async statFile(path) {
      const bytes = files.get(path)
      if (!bytes) return null
      return { size: bytes.length, mtimeMs: mtimes.get(path) ?? null }
    },
    async isDirectory(path) {
      return isDir(path)
    },
    async exists(path) {
      return files.has(path) || isDir(path)
    },
    async readRange(path, offset, length) {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`ENOENT: ${path}`)
      return bytes.subarray(offset, offset + length)
    },
    async appendBytes(path, bytes) {
      const prev = files.get(path)
      const merged = new Uint8Array((prev?.length ?? 0) + bytes.length)
      if (prev) merged.set(prev, 0)
      merged.set(bytes, prev?.length ?? 0)
      files.set(path, merged)
      stamp(path)
    },
    async rename(from, to) {
      const bytes = files.get(from)
      if (!bytes) throw new Error(`ENOENT: ${from}`)
      // 与 Windows 的 rename 语义对齐：目标已存在直接失败（正是线上那条「收尾时被抢名」的路径）
      if (files.has(to)) throw new Error(`EEXIST: ${to}`)
      files.set(to, bytes)
      files.delete(from)
      mtimes.delete(from)
      stamp(to)
    },
    async replaceFile(from, to) {
      const bytes = files.get(from)
      if (!bytes) throw new Error(`ENOENT: ${from}`)
      // 与 rename 的差别就在这里：**允许目标已存在**（一次赋值 = 原子替换）
      files.set(to, bytes)
      files.delete(from)
      mtimes.delete(from)
      stamp(to)
    },
    async remove(path) {
      files.delete(path)
    },
    paths() {
      return [...files.keys()].sort()
    },
    read(path) {
      return files.get(path) ?? null
    },
    touch(path, content) {
      files.set(path, typeof content === 'string' ? encoder.encode(content) : content)
      stamp(path)
    },
  }
}

/* ───────────────────────── 装配 ───────────────────────── */

interface Harness {
  caller: ReturnType<typeof createCaller<HostApi>>
  fs: MemoryFs
  /** 记录 `resolvePath` 收到的入参（验证「手机传什么、电脑侧看到什么」）。 */
  resolved: Array<{ input: string; mode: string }>
  dispose(): void
}

function setup(
  options: {
    /** 初始磁盘内容（键是**相对**工作目录的路径，装配时补成绝对路径）。 */
    files?: Record<string, string | Uint8Array>
    capabilities?: Capability[]
    linkKind?: () => 'direct' | 'relay' | 'unknown'
    /** 模拟安全校验拒绝（返回非空 = 拒，值是拒绝理由）。 */
    deny?: (input: string) => string | null
  } = {},
): Harness {
  const initial: Record<string, string | Uint8Array> = {
    [abs('README.md')]: '# 演示',
    [abs('src/a.ts')]: 'export const a = 1',
  }
  for (const [relPath, content] of Object.entries(options.files ?? {})) initial[abs(relPath)] = content
  const fs = createMemoryFs(initial)

  const resolved: Array<{ input: string; mode: string }> = []
  sessionStore.saveSession(makeSession(SESSION_ID, WORKSPACE))
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 3000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-test',
    // 文件接口层的两处本机资源都换成受控实现（其余 —— ACL / 分发 / 握手闸门 —— 全是真的）
    fileSystem: fs,
    resolvePath: async (input, mode) => {
      resolved.push({ input, mode })
      const denial = options.deny?.(input)
      // 与真实 securityService 同形：安全拒绝抛的是**普通 Error**（它还要服务桌面文件工具）
      if (denial) throw new Error(denial)
      return input ? abs(input) : WORKSPACE
    },
    ...(options.linkKind ? { linkKind: options.linkKind } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  })
  return {
    caller: createCaller<HostApi>(mobileEp),
    fs,
    resolved,
    dispose: () => {
      bridge.dispose()
      hostEp.dispose()
      mobileEp.dispose()
      hostT.close()
      mobileT.close()
    },
  }
}

/** 把一份字节分块传上去（走真实 RPC），返回收尾应答。 */
async function upload(
  caller: Harness['caller'],
  params: { dir?: string; name: string; size: number; onConflict?: 'rename' | 'reject' },
  data: Uint8Array,
): Promise<FileWriteFinishResult> {
  const begin: FileWriteBeginResult = await caller.call('host.file.write.begin', {
    sessionId: SESSION_ID,
    ...params,
  })
  let sent = 0
  while (sent < data.length) {
    const slice = data.subarray(sent, sent + FILE_CHUNK_BYTES)
    await caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: sent,
      data: bytesToBase64(slice),
    })
    sent += slice.length
  }
  return caller.call('host.file.write.finish', { uploadId: begin.uploadId })
}

function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 53 + 17) & 0xff
  return bytes
}

/** 磁盘上有没有临时态（`.virlen-part`）。 */
function hasTempFile(fs: MemoryFs): boolean {
  return fs.paths().some((path) => path.includes('.virlen-part'))
}

/* ───────────────────────── 用例 ───────────────────────── */

describe('§37 电脑侧文件接口层', () => {
  let h: Harness

  beforeEach(() => {
    sessionStore.clear()
    h = setup()
  })

  afterEach(() => {
    sessionStore.clear()
  })

  it('列目录：目录在前，相对 / 绝对路径都由电脑侧给全', async () => {
    const page: FileListResult = await h.caller.call('host.file.list', { sessionId: 's-1' })
    expect(page.relPath).toBe('')
    expect(page.absPath).toBe(WORKSPACE)
    expect(page.entries.map((e) => e.name)).toEqual(['src', 'README.md'])
    expect(page.entries[0].isDir).toBe(true)

    const sub = await h.caller.call('host.file.list', { sessionId: 's-1', path: 'src' })
    expect(sub.relPath).toBe('src')
    expect(sub.absPath).toBe(abs('src'))
    expect(sub.entries.map((e) => e.name)).toEqual(['a.ts'])
    // 相对路径到了电脑侧才变成绝对路径（两端都不自己拼）
    expect(h.resolved.some((r) => r.input === 'src' && r.mode === 'r')).toBe(true)
  })

  it('目录不存在 vs 不是目录：给两种不同的结论', async () => {
    await expect(h.caller.call('host.file.list', { sessionId: 's-1', path: 'nope' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    await expect(h.caller.call('host.file.list', { sessionId: 's-1', path: 'README.md' })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
    })
  })

  it('读文件：首块给全量大小与分类；单块被夹到 256KB；分块拼起来字节一致', async () => {
    const content = makeBytes(FILE_CHUNK_BYTES + 321)
    h.dispose()
    h = setup({ files: { 'big.log': content } })

    const first: FileReadResult = await h.caller.call('host.file.read', {
      sessionId: 's-1',
      path: 'big.log',
      length: 10,
    })
    expect(first.offset).toBe(0)
    expect(first.size).toBe(content.length)
    // 分类与 MIME 由电脑侧给（手机端不靠自己的表猜）
    expect(first.kind).toBe('text')
    expect(first.mime).toBe('text/plain')
    expect(first.eof).toBe(false)
    expect(base64ToBytes(first.data).length).toBe(10)

    // 第二块请求一个**超上限**的长度：电脑侧夹到 FILE_CHUNK_BYTES
    const second = await h.caller.call('host.file.read', {
      sessionId: 's-1',
      path: 'big.log',
      offset: 10,
      length: 10 * FILE_CHUNK_BYTES,
    })
    expect(base64ToBytes(second.data).length).toBe(FILE_CHUNK_BYTES)
    expect(second.eof).toBe(false)

    const tail = await h.caller.call('host.file.read', {
      sessionId: 's-1',
      path: 'big.log',
      offset: 10 + FILE_CHUNK_BYTES,
    })
    expect(tail.eof).toBe(true)

    const merged = new Uint8Array([
      ...base64ToBytes(first.data),
      ...base64ToBytes(second.data),
      ...base64ToBytes(tail.data),
    ])
    expect([...merged]).toEqual([...content])
  })

  it('读目录 / 读不存在的文件：两条不同的错误结论', async () => {
    await expect(h.caller.call('host.file.read', { sessionId: 's-1', path: 'src' })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
    })
    await expect(h.caller.call('host.file.read', { sessionId: 's-1', path: 'nope.txt' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('越权：`..` 被规整后才送安全校验；安全校验拒绝 → E_DENIED（不是「电脑端内部错误」）', async () => {
    // 逃逸段被就地吃掉：送到安全校验面前的是 `etc/passwd`（工作目录内），而不是一条穿出去的路径
    await h.caller
      .call('host.file.read', { sessionId: 's-1', path: '../../etc/passwd' })
      .catch(() => {})
    expect(h.resolved[h.resolved.length - 1]?.input).toBe('etc/passwd')
    // 真被安全策略拦住时，手机端拿到的是「无权访问」，而不是「电脑端内部错误」
    const denied = setup({ deny: (input) => (input.startsWith('secret') ? '路径不在允许的工作目录内' : null) })
    await expect(denied.caller.call('host.file.list', { sessionId: 's-1', path: 'secret' })).rejects.toMatchObject({
      code: 'E_DENIED',
      message: '路径不在允许的工作目录内',
    })
    denied.dispose()
  })

  it('中继链路：文件方法一律拒（同一句话）；中途被切成中继时连分块都拒，但 abort 仍放行', async () => {
    // ① 一开始就是中继：三个「不需要已有上传票据」的方法直接拒
    const relay = setup({ linkKind: () => 'relay' })
    for (const call of [
      () => relay.caller.call('host.file.list', { sessionId: SESSION_ID }),
      () => relay.caller.call('host.file.read', { sessionId: SESSION_ID, path: 'README.md' }),
      () => relay.caller.call('host.file.write.begin', { sessionId: SESSION_ID, name: 'a.txt', size: 1 }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'E_DENIED', message: FILE_DIRECT_ONLY_MESSAGE })
    }
    /*
     * 上传票据的真假**先于**链路门：一个不存在的 `uploadId` 就是不存在，
     * 拿链路原因去盖它只会让排查变难（票据是本地审计的事实，链路是策略）。
     */
    await expect(
      relay.caller.call('host.file.write.chunk', { uploadId: 'x', offset: 0, data: '' }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    // 清理例外：链路是中继时，临时文件仍必须能被清掉
    await expect(relay.caller.call('host.file.write.abort', { uploadId: 'x' })).resolves.toEqual({ ok: true })
    relay.dispose()

    // ② 直连开局、传到一半链路被切成中继：分块与收尾都必须拒（不能继续往服务器里灌字节）
    let kind: 'direct' | 'relay' = 'direct'
    const flip = setup({ linkKind: () => kind })
    const begin = await flip.caller.call('host.file.write.begin', {
      sessionId: SESSION_ID,
      name: 'mid.txt',
      size: 4,
    })
    kind = 'relay'
    await expect(
      flip.caller.call('host.file.write.chunk', {
        uploadId: begin.uploadId,
        offset: 0,
        data: bytesToBase64(makeBytes(4)),
      }),
    ).rejects.toMatchObject({ code: 'E_DENIED', message: FILE_DIRECT_ONLY_MESSAGE })
    await expect(flip.caller.call('host.file.write.finish', { uploadId: begin.uploadId })).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    // 一个字节都没落盘（分块在 append 之前就被拦下了）
    expect(flip.fs.paths()).not.toContain(abs('mid.txt'))
    // 而此刻最需要的就是能清掉临时态 —— abort 不过链路门
    await expect(flip.caller.call('host.file.write.abort', { uploadId: begin.uploadId })).resolves.toEqual({
      ok: true,
    })
    expect(hasTempFile(flip.fs)).toBe(false)
    flip.dispose()

    // ③ unknown（同源 Broadcast 联调 / 非 WebRTC 链路）必须放行 —— 否则这个功能在联调里根本进不来
    const unknown = setup({ linkKind: () => 'unknown' })
    await expect(unknown.caller.call('host.file.list', { sessionId: SESSION_ID })).resolves.toMatchObject({
      relPath: '',
    })
    unknown.dispose()
  })

  it('ACL：链路没有 file.upload → 上传被拒，且**根本不会碰磁盘**', async () => {
    const limited = setup({
      capabilities: DEFAULT_CAPABILITIES.filter((cap) => cap !== 'file.upload'),
    })
    await expect(
      limited.caller.call('host.file.write.begin', { sessionId: 's-1', name: 'a.txt', size: 3 }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(limited.fs.paths()).toEqual([abs('README.md'), abs('src/a.ts')])
    // 只读两档照旧可用（这就是把能力拆成三个位的意义）
    await expect(limited.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })).resolves.toBeTruthy()
    limited.dispose()
  })

  it('上传：finish 之前磁盘上只有临时文件；finish 之后字节一模一样', async () => {
    const data = makeBytes(300 * 1024)
    const begin = await h.caller.call('host.file.write.begin', {
      sessionId: 's-1',
      dir: 'src',
      name: 'from-phone.ts',
      size: data.length,
    })
    expect(begin.relPath).toBe('src/from-phone.ts')

    let sent = 0
    while (sent < data.length) {
      const slice = data.subarray(sent, sent + FILE_CHUNK_BYTES)
      await h.caller.call('host.file.write.chunk', {
        uploadId: begin.uploadId,
        offset: sent,
        data: bytesToBase64(slice),
      })
      sent += slice.length
    }
    // 还没收尾：目标文件**不存在**，磁盘上只有临时态（「原子落盘」的那一半）
    expect(h.fs.paths()).not.toContain(abs('src/from-phone.ts'))
    expect(hasTempFile(h.fs)).toBe(true)

    const done = await h.caller.call('host.file.write.finish', { uploadId: begin.uploadId })
    expect(done).toMatchObject({ name: 'from-phone.ts', relPath: 'src/from-phone.ts', size: data.length })
    expect([...(h.fs.read(abs('src/from-phone.ts')) ?? [])]).toEqual([...data])
    // 临时文件已清掉（不留垃圾）
    expect(hasTempFile(h.fs)).toBe(false)
  })

  it('上传的几道闸：超限 / 非法名 / 乱序 / 超申报字节 / 未传完', async () => {
    await expect(
      h.caller.call('host.file.write.begin', {
        sessionId: 's-1',
        name: 'huge.bin',
        size: FILE_UPLOAD_MAX_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })

    await expect(
      h.caller.call('host.file.write.begin', { sessionId: 's-1', name: 'a/b.txt', size: 1 }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })

    const begin = await h.caller.call('host.file.write.begin', {
      sessionId: 's-1',
      name: 'order.txt',
      size: 6,
    })
    // 乱序：偏移必须等于已接收字节数
    await expect(
      h.caller.call('host.file.write.chunk', {
        uploadId: begin.uploadId,
        offset: 3,
        data: bytesToBase64(makeBytes(3)),
      }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })

    await h.caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: 0,
      data: bytesToBase64(makeBytes(3)),
    })
    // 超过申报大小
    await expect(
      h.caller.call('host.file.write.chunk', {
        uploadId: begin.uploadId,
        offset: 3,
        data: bytesToBase64(makeBytes(9)),
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })

    // 未传完就收尾 → 拒，且**临时态还在**（补完剩下几块仍能收尾 —— 弱网下一断不必从头传）
    await expect(h.caller.call('host.file.write.finish', { uploadId: begin.uploadId })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
    })
    expect(hasTempFile(h.fs)).toBe(true)

    await h.caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: 3,
      data: bytesToBase64(makeBytes(3)),
    })
    await expect(h.caller.call('host.file.write.finish', { uploadId: begin.uploadId })).resolves.toMatchObject({
      name: 'order.txt',
      size: 6,
    })
    expect(h.fs.read(abs('order.txt'))?.length).toBe(6)
  })

  it('同名冲突：默认加「 - 副本」（与桌面文件操作同口径），reject 策略则直接拒', async () => {
    const renamed = await upload(h.caller, { name: 'README.md', size: 4 }, new TextEncoder().encode('abcd'))
    expect(renamed.name).toBe('README - 副本.md')
    expect(h.fs.read(abs('README - 副本.md'))).toBeTruthy()

    await expect(
      h.caller.call('host.file.write.begin', {
        sessionId: 's-1',
        name: 'README.md',
        size: 1,
        onConflict: 'reject',
      }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })
  })

  it('放弃上传：临时文件被清掉，目标文件从头到尾都不存在', async () => {
    const begin = await h.caller.call('host.file.write.begin', {
      sessionId: 's-1',
      name: 'half.txt',
      size: 10,
    })
    await h.caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: 0,
      data: bytesToBase64(makeBytes(4)),
    })
    await h.caller.call('host.file.write.abort', { uploadId: begin.uploadId })
    expect(h.fs.paths()).toEqual([abs('README.md'), abs('src/a.ts')])
    // 收尾也不会再成功（临时态已消失）
    await expect(h.caller.call('host.file.write.finish', { uploadId: begin.uploadId })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })
})

/* ───────────────────────── 编辑保存（覆写已有文件） ───────────────────────── */

/** 走一遍「开始 → 分块 → 收尾」（**覆写**模式），返回收尾应答。 */
async function saveEdit(
  caller: Harness['caller'],
  params: { dir?: string; name: string; expectMtimeMs: number; expectSize?: number },
  data: Uint8Array,
): Promise<FileWriteFinishResult> {
  const begin: FileWriteBeginResult = await caller.call('host.file.write.begin', {
    sessionId: SESSION_ID,
    dir: params.dir ?? '',
    name: params.name,
    size: data.length,
    overwrite: true,
    expectMtimeMs: params.expectMtimeMs,
    ...(params.expectSize != null ? { expectSize: params.expectSize } : {}),
  })
  let sent = 0
  while (sent < data.length) {
    const slice = data.subarray(sent, sent + FILE_CHUNK_BYTES)
    await caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: sent,
      data: bytesToBase64(slice),
    })
    sent += slice.length
  }
  return caller.call('host.file.write.finish', { uploadId: begin.uploadId })
}

function textOf(bytes: Uint8Array | null): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array(0))
}

describe('§37 电脑侧文件接口层 · 编辑保存（覆写）', () => {
  let h: Harness

  beforeEach(() => {
    sessionStore.clear()
    h = setup()
  })

  afterEach(() => {
    sessionStore.clear()
  })

  it('读文件带上版本凭据（mtimeMs）——没有它，手机端不会给编辑入口', async () => {
    const read: FileReadResult = await h.caller.call('host.file.read', {
      sessionId: 's-1',
      path: 'README.md',
    })
    expect(typeof read.mtimeMs).toBe('number')
    expect(read.size).toBe(h.fs.read(abs('README.md'))!.length)
  })

  it('覆写：内容被换掉、路径不变、**不产生「 - 副本」**、回执给新版本', async () => {
    const before = await h.caller.call('host.file.read', { sessionId: 's-1', path: 'src/a.ts' })
    const data = new TextEncoder().encode('export const a = 2\n')
    const done = await saveEdit(
      h.caller,
      { dir: 'src', name: 'a.ts', expectMtimeMs: before.mtimeMs, expectSize: before.size },
      data,
    )
    expect(done).toMatchObject({ name: 'a.ts', relPath: 'src/a.ts', size: data.length })
    // 回执必须带上**新的** mtime：手机端连改两次时，第二次的校验得用这个值
    expect(done.mtimeMs).not.toBe(before.mtimeMs)
    expect(textOf(h.fs.read(abs('src/a.ts')))).toBe('export const a = 2\n')
    // 改名口径只属于上传：磁盘上不该多出任何副本
    expect(h.fs.paths()).toEqual([abs('README.md'), abs('src/a.ts')])
    expect(hasTempFile(h.fs)).toBe(false)

    const second = await saveEdit(
      h.caller,
      { dir: 'src', name: 'a.ts', expectMtimeMs: done.mtimeMs, expectSize: data.length },
      new TextEncoder().encode('export const a = 3\n'),
    )
    expect(second.size).toBe('export const a = 3\n'.length)
  })

  it('与上传的「同名加 - 副本」是两条路：上传照旧加副本，覆写原地改', async () => {
    const up = await upload(h.caller, { name: 'README.md', size: 3 }, new TextEncoder().encode('abc'))
    expect(up.name).toBe('README - 副本.md')

    const before = await h.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })
    const done = await saveEdit(
      h.caller,
      { name: 'README.md', expectMtimeMs: before.mtimeMs },
      new TextEncoder().encode('# 改过\n'),
    )
    expect(done.relPath).toBe('README.md')
    expect(textOf(h.fs.read(abs('README.md')))).toBe('# 改过\n')
  })

  it('冲突（开始前）：期间电脑侧改过 → 拒，原文件一字未动、不留临时文件', async () => {
    const before = await h.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })
    // 模拟 AI / 用户在电脑上改了它
    h.fs.touch(abs('README.md'), '# 电脑上改过了\n')

    await expect(
      saveEdit(h.caller, { name: 'README.md', expectMtimeMs: before.mtimeMs }, new TextEncoder().encode('x')),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' })
    expect(textOf(h.fs.read(abs('README.md')))).toBe('# 电脑上改过了\n')
    expect(hasTempFile(h.fs)).toBe(false)
  })

  it('冲突（落盘前）：分块还在路上时文件又变了 → 收尾前那次校验拦住它', async () => {
    const before = await h.caller.call('host.file.read', { sessionId: 's-1', path: 'src/a.ts' })
    const begin: FileWriteBeginResult = await h.caller.call('host.file.write.begin', {
      sessionId: 's-1',
      dir: 'src',
      name: 'a.ts',
      size: 4,
      overwrite: true,
      expectMtimeMs: before.mtimeMs,
    })
    await h.caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: 0,
      data: bytesToBase64(makeBytes(4)),
    })
    h.fs.touch(abs('src/a.ts'), 'export const a = 99')

    await expect(h.caller.call('host.file.write.finish', { uploadId: begin.uploadId })).rejects.toMatchObject({
      code: 'E_CONFLICT',
    })
    // 别人的那一版留着，自己的临时态清掉（不留垃圾、也不覆盖）
    expect(textOf(h.fs.read(abs('src/a.ts')))).toBe('export const a = 99')
    expect(hasTempFile(h.fs)).toBe(false)
  })

  it('覆写的几道闸：目标不存在 / 非文本 / 缺版本 / 超编辑上限', async () => {
    const before = await h.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })
    const base = { sessionId: 's-1', size: 3, overwrite: true as const, expectMtimeMs: before.mtimeMs }

    // ① 不存在 → E_NOT_FOUND（**不新建**：手机端一个路径笔误不该在用户目录里造出文件）
    await expect(h.caller.call('host.file.write.begin', { ...base, name: 'nope.txt' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    // ② 图片 / 二进制不给编辑（手机端没有入口，电脑侧独立再拒一次）
    h.fs.touch(abs('app.bin'), 'binary-ish')
    await expect(h.caller.call('host.file.write.begin', { ...base, name: 'app.bin' })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
    })
    // ③ 不给版本 → 拒：于是「盲写」这条路根本不存在
    await expect(
      h.caller.call('host.file.write.begin', {
        sessionId: 's-1',
        name: 'README.md',
        size: 3,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    // ④ 编辑上限（256KB）比上传上限（32MB）严得多
    await expect(
      h.caller.call('host.file.write.begin', { ...base, name: 'README.md', size: FILE_EDIT_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
  })

  it('ACL：编辑与上传两档各自独立（只开其中一档时，另一档照样被拒）', async () => {
    // 只留编辑：保存可用，但传新文件不行
    const editOnly = setup({ capabilities: DEFAULT_CAPABILITIES.filter((cap) => cap !== 'file.upload') })
    const before = await editOnly.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })
    await expect(
      saveEdit(editOnly.caller, { name: 'README.md', expectMtimeMs: before.mtimeMs }, new TextEncoder().encode('x')),
    ).resolves.toMatchObject({ relPath: 'README.md' })
    await expect(
      editOnly.caller.call('host.file.write.begin', { sessionId: 's-1', name: 'new.txt', size: 1 }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    editOnly.dispose()

    // 只留上传：新建可用，但覆写被拒（且**根本不会碰磁盘**）
    const uploadOnly = setup({ capabilities: DEFAULT_CAPABILITIES.filter((cap) => cap !== 'file.edit') })
    const read = await uploadOnly.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })
    await expect(
      uploadOnly.caller.call('host.file.write.begin', {
        sessionId: 's-1',
        name: 'README.md',
        size: 1,
        overwrite: true,
        expectMtimeMs: read.mtimeMs,
      }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    await expect(
      uploadOnly.caller.call('host.file.write.begin', { sessionId: 's-1', name: 'new.txt', size: 1 }),
    ).resolves.toMatchObject({ name: 'new.txt' })
    uploadOnly.dispose()
  })

  it('覆写与上传走同一道门：非中继、安全校验（越权 → E_DENIED）', async () => {
    const relay = setup({ linkKind: () => 'relay' })
    await expect(
      relay.caller.call('host.file.write.begin', {
        sessionId: 's-1',
        name: 'README.md',
        size: 1,
        overwrite: true,
        expectMtimeMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_DENIED', message: FILE_DIRECT_ONLY_MESSAGE })
    relay.dispose()

    const denied = setup({ deny: (input) => (input.startsWith('secret') ? '路径不在允许的工作目录内' : null) })
    await expect(
      denied.caller.call('host.file.write.begin', {
        sessionId: 's-1',
        dir: 'secret',
        name: 'a.ts',
        size: 1,
        overwrite: true,
        expectMtimeMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_DENIED', message: '路径不在允许的工作目录内' })
    denied.dispose()
  })

  it('中途放弃：原文件保持原样', async () => {
    const before = await h.caller.call('host.file.read', { sessionId: 's-1', path: 'README.md' })
    const original = textOf(h.fs.read(abs('README.md')))
    const begin: FileWriteBeginResult = await h.caller.call('host.file.write.begin', {
      sessionId: 's-1',
      name: 'README.md',
      size: 4,
      overwrite: true,
      expectMtimeMs: before.mtimeMs,
    })
    await h.caller.call('host.file.write.chunk', {
      uploadId: begin.uploadId,
      offset: 0,
      data: bytesToBase64(makeBytes(4)),
    })
    await h.caller.call('host.file.write.abort', { uploadId: begin.uploadId })
    expect(textOf(h.fs.read(abs('README.md')))).toBe(original)
    expect(hasTempFile(h.fs)).toBe(false)
  })
})
