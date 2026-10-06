/**
 * 电脑侧「工作目录文件」接口层（§37）—— 手机端浏览 / 预览 / 下载 / 上传 / **编辑**本机文件的落点。
 *
 * ## 为什么单独一个文件（而不是塞进 `host-source.ts`）
 *
 * `host-source.ts` 接的是 `sessionStore` / `chat-service`（会话域），而这里接的是
 * **文件系统 + 安全校验**（另一套依赖、另一套失败模式）。分开的收益很具体：
 * 本文件可以在没有 Tauri、没有会话库的环境下被完整单测（注入内存版 `FileSystemPort`）。
 *
 * ## 六条纪律（改动时逐条对照）
 *
 * 1. **越权防线只有一道，且必须是 `resolvePath`**：手机传来的路径先被
 *    `normalizeRelPath` 规整（`..` 逃逸段就地丢掉），再由 `resolvePath` 落到会话工作目录
 *    并过黑白名单。本文件**不得**自己做路径拼接 —— 两份拼接逻辑就是两个边界。
 * 2. **非中继**：`fileTransferDeniedReason(linkKind())` 说了算（两端同一句话）。
 *    只拒**确认走了 TURN 中继**的链路（`relay`），`unknown` 放行（否则 Broadcast 联调
 *    与非 WebRTC 链路永远进不来）。唯一的例外是 `abort`（只做清理，见那里的注释）。
 * 3. **分块**：单次 RPC 最多 `FILE_CHUNK_BYTES` 字节；读写都按这个上限夹一次。
 *    上限的另一层含义是**内存上界**：一次请求最多拼一份 256KB 的字节 + 350KB 的 base64。
 * 4. **一切写入都先落临时文件、`finish` 才落盘**：中断 / 取消 / 出错都不会在用户项目里
 *    留下一个「打开是坏的」半截文件。
 * 5. **每一步都独立 `assert`**（§7-⑪ 的教训）：手机端不显示入口绝不等于隔离。
 * 6. **覆写（编辑保存）与上传是同一条分块通道上的两条路**（`overwrite` 切换）：覆写要求目标
 *    已存在、必须带打开时的版本（`expectMtimeMs`）、`finish` 时**替换**目标而不是挑空位改名；
 *    授权也是另一档（`file.edit`）。收尾前**再校验一次**版本 —— begin 与 finish 之间隔着网络。
 */
import {
  BridgeError,
  FILE_BROWSE_CAPABILITY,
  FILE_CHUNK_BYTES,
  FILE_DOWNLOAD_CAPABILITY,
  FILE_EDIT_CAPABILITY,
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_MAX_ENTRIES,
  FILE_UPLOAD_CAPABILITY,
  FILE_UPLOAD_MAX_BYTES,
  UPLOAD_PART_SUFFIX,
  base64ToBytes,
  baseNameOfPath,
  bytesToBase64,
  compareFileEntries,
  duplicateNameCandidate,
  fileTransferDeniedReason,
  formatFileSize,
  isEditableFileName,
  isSafeEntryName,
  mimeTypeOf,
  normalizeRelPath,
  previewKindOf,
  toBridgeError,
  type FileEntryDTO,
  type FileListParams,
  type FileListResult,
  type FileReadParams,
  type FileReadResult,
  type FileWriteAbortParams,
  type FileWriteBeginParams,
  type FileWriteBeginResult,
  type FileWriteChunkParams,
  type FileWriteChunkResult,
  type FileWriteFinishParams,
  type FileWriteFinishResult,
  type HostDataSource,
} from 'virlen-remote'
import type { Acl } from './acl'
import type { AuditLog } from './audit'
import { normalizeWorkspace } from './dto'
import type { LinkKind } from './link-kind'

/** 本接口层实现的六个方法（从 `HostDataSource` 里挑出来，免得两处各写一份形状）。 */
export type HostFiles = Pick<
  HostDataSource,
  | 'listFiles'
  | 'readFile'
  | 'beginFileWrite'
  | 'writeFileChunk'
  | 'finishFileWrite'
  | 'abortFileWrite'
>

/** 一条目录条目（端口层形状；协议 DTO 在 `files.ts` 里组装）。 */
export interface FileSysEntry {
  name: string
  isDir: boolean
  size: number
  mtimeMs?: number
}

/**
 * 文件系统端口 —— 「真正碰磁盘」的那一层。
 *
 * 为什么要有它：本文件的全部纪律（带宽夹取、临时文件、上限、越权路径规整）都值得被单测，
 * 而单测里没有 Tauri。端口一隔，测试注入内存实现即可覆盖全部逻辑分支；
 * 生产实现见 `file-tauri.ts`。
 */
export interface FileSystemPort {
  /** 列目录（**非递归**；隐藏文件由 `includeHidden` 决定）。 */
  listDir(dir: string, options: { includeHidden: boolean }): Promise<FileSysEntry[]>
  /**
   * 文件的大小与修改时刻（不存在 / 是目录 → `null`）。
   *
   * 一次 `stat` 同时给两个值：大小用于分块读取与冲突校验，而 `mtimeMs` 是**编辑保存的版本凭据**
   * （手机端打开时记下、保存时回传）。拿不到 `mtimeMs` 的端口实现会让编辑整体不可用
   * —— 有意的 fail-closed：确认不了版本，就不该拿一份可能已过期的内容去覆盖别人的改动。
   */
  statFile(path: string): Promise<{ size: number; mtimeMs: number | null } | null>
  /** 是否目录（不存在 → `false`）。 */
  isDirectory(path: string): Promise<boolean>
  /** 是否存在（文件或目录都算）。 */
  exists(path: string): Promise<boolean>
  /** 读一段字节（`length` 已由调用方夹在上限内；越界部分按实际长度返回）。 */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>
  /** 追加写（目标不存在则创建；**只增不改**，与临时文件语义匹配）。 */
  appendBytes(path: string, bytes: Uint8Array): Promise<void>
  /** 改名（上传收尾：临时文件 → 目标名）。 */
  rename(from: string, to: string): Promise<void>
  /**
   * **替换**目标（目标已存在则覆盖）。
   *
   * 为何不直接用 `rename`：两条契约不同。`rename` 只往「已经挑好的空位」改名（目标已存在即失败
   * ——Windows 语义，也是上传冲突消解的前提）；这里是**覆写已有文件**（编辑保存的收尾）。
   * 分开写，内存端口才能把「替换」实现成一次赋值，而不是绕着 `rename` 拼一个「先删再改名」
   * （那会在两次系统调用之间留一个「文件不存在」的窗口）。
   */
  replaceFile(from: string, to: string): Promise<void>
  /** 删除文件（用于清理临时文件；不存在时不报错）。 */
  remove(path: string): Promise<void>
}

export interface HostFilesDeps {
  acl: Acl
  audit: AuditLog
  /** 文件系统端口（生产 = Tauri；测试 = 内存）。 */
  files: FileSystemPort
  /**
   * 路径安全校验 —— 与桌面文件工具**同一个入口**（`securityService.resolveSafePath`）：
   * 相对路径按会话工作目录解析，绝对路径走黑白名单。
   *
   * ⚠️ 不传 = 该功能整体不可用（每个方法报 `E_UNSUPPORTED`）。这是刻意的：
   * 没有安全校验的文件接口**不该有默认实现**。
   */
  resolvePath?: (input: string, mode: 'r' | 'w', sessionId: string) => Promise<string>
  /** 会话工作目录（生产 = `sessionStore`）；`null` = 会话不存在。 */
  workspaceOf?: (sessionId: string) => string | null
  /**
   * 当前链路通讯类型（非中继门槛）。
   *
   * 不传 = 不限制（单测 / 联调；生产由 `PhoneControlService` 注入 `() => kindWatch.kind`）。
   */
  linkKind?: () => LinkKind
}

/** 一次进行中的上传（内存态；`finish` / `abort` 之后即消失）。 */
interface Upload {
  sessionId: string
  /** 目标文件名（冲突消解后的最终名）。 */
  name: string
  /** 目标绝对路径。 */
  absPath: string
  /** 相对工作目录的路径（回给手机显示）。 */
  relPath: string
  /** 临时文件绝对路径（真字节先写这里）。 */
  tempPath: string
  /** 手机申报的总大小。 */
  declaredSize: number
  /** 已接收字节数（也用作「下一块的期望偏移」）。 */
  received: number
  /** `true` = **覆写已有文件**（编辑保存）；缺省 = 上传新建（同名走「 - 副本」）。 */
  overwrite?: boolean
  /** 覆写时手机端声明「打开时就是这个版本」—— `finish` 落盘前再校验一次。 */
  baseMtimeMs?: number
  baseSize?: number
}

/** 冲突消解时最多往后找几个候选名（与桌面侧 `file-transfer-service` 同量级）。 */
const MAX_DUPLICATE_TRIES = 100

export function createHostFiles(deps: HostFilesDeps): HostFiles {
  const { acl, audit, files } = deps
  const uploads = new Map<string, Upload>()
  let uploadSeq = 0

  /** 会话工作目录（归一化；会话不存在 → `E_NOT_FOUND`）。 */
  const requireWorkspace = (sessionId: string): string => {
    const workspace = normalizeWorkspace(deps.workspaceOf?.(sessionId))
    if (!workspace) throw new BridgeError('E_NOT_FOUND', `会话不存在：${sessionId}`)
    return workspace
  }

  /** 安全解析（相对工作目录 → 绝对路径 + 黑白名单校验）。 */
  const safePath = async (
    input: string,
    mode: 'r' | 'w',
    sessionId: string,
    method: string,
  ): Promise<string> => {
    const resolvePath = deps.resolvePath
    if (!resolvePath) throw new BridgeError('E_UNSUPPORTED', '本机未配置文件访问能力')
    let resolved: string
    try {
      resolved = await resolvePath(input, mode, sessionId)
    } catch (err) {
      /*
       * 安全校验拒绝（工作目录外 / 黑名单 / 白名单外）→ `E_DENIED`。
       *
       * 为何在这里归一：`securityService.resolveSafePath` 抛的是一个普通 `Error`（它还要服务
       * 桌面文件工具，不该依赖协议层的错误类型），不归的话手机端看到的是「电脑端内部错误：
       * 路径不在…」——把一次**正常的越权拒绝**说成电脑坏了，用户会去重试、去报修。
       * 文案保留原样（那是 `securityPort.isPathAllowed` 给出的真实理由）。
       */
      const message = err instanceof Error ? err.message : String(err)
      if (BridgeError.is(err)) throw err
      audit.record({ method, allowed: false, sessionId, detail: message })
      throw new BridgeError('E_DENIED', message, { cause: err })
    }
    const normalized = normalizeWorkspace(resolved)
    if (!normalized) throw new BridgeError('E_INTERNAL', '路径解析失败')
    return normalized
  }

  /**
   * 非中继门槛。命中即**留痕**再抛 —— 「因为链路是中继所以没给你传」必须出现在审计里，
   * 否则用户报「手机上点不动」时无从查证。
   */
  const assertLinkUsable = (sessionId: string, method: string): void => {
    const reason = deps.linkKind ? fileTransferDeniedReason(deps.linkKind()) : null
    if (!reason) return
    audit.record({ method, allowed: false, sessionId, detail: reason })
    throw new BridgeError('E_DENIED', reason)
  }

  /** 冲突消解：`a.txt` → `a - 副本.txt` → `a - 副本 (2).txt`（与桌面文件操作同一条口径）。 */
  const resolveAvailableName = async (dir: string, name: string): Promise<string> => {
    const join = (n: string): string => (dir ? `${dir}/${n}` : n)
    if (!(await files.exists(join(name)))) return name
    for (let index = 1; index <= MAX_DUPLICATE_TRIES; index++) {
      const candidate = duplicateNameCandidate(name, index)
      if (!(await files.exists(join(candidate)))) return candidate
    }
    throw new BridgeError('E_CONFLICT', '同名文件过多，无法自动改名')
  }

  const requireUpload = (uploadId: string): Upload => {
    const upload = uploads.get(uploadId)
    if (!upload) throw new BridgeError('E_NOT_FOUND', `上传任务不存在或已结束：${uploadId}`)
    return upload
  }

  /**
   * 取一条在途写入并校验授权。
   *
   * 授权按**这条记录自己的写入方式**算（覆写 = `file.edit`，新建 = `file.upload`）：用户完全可能
   * 只放开「改写已有文件」而关掉上传（或反过来），一律按上传那档 assert 会让其中一种配置彻底用不了。
   * 校验放在取记录之后是安全的：记录本身是 `begin` 时**已经过授权**才建出来的。
   */
  const requireAuthorizedUpload = (uploadId: string): Upload => {
    const upload = requireUpload(uploadId)
    acl.assert(upload.overwrite ? FILE_EDIT_CAPABILITY : FILE_UPLOAD_CAPABILITY)
    return upload
  }

  /** 目录必须存在（手机端点进去的是一个已消失的目录时，给明确结论而不是空列表）。 */
  const requireDirectory = async (absPath: string, relPath: string): Promise<void> => {
    if (await files.isDirectory(absPath)) return
    if (await files.exists(absPath)) {
      throw new BridgeError('E_BAD_REQUEST', `不是目录：${relPath || '/'}`)
    }
    throw new BridgeError('E_NOT_FOUND', `目录不存在：${relPath || '/'}`)
  }

  return {
    async listFiles(params: FileListParams): Promise<FileListResult> {
      acl.assert(FILE_BROWSE_CAPABILITY)
      assertLinkUsable(params.sessionId, 'host.file.list')
      requireWorkspace(params.sessionId)
      const relPath = normalizeRelPath(params.path ?? '')
      const absPath = await safePath(relPath, 'r', params.sessionId, 'host.file.list')
      await requireDirectory(absPath, relPath)
      const raw = await files.listDir(absPath, { includeHidden: false }).catch((err) => {
        throw toBridgeError(err)
      })
      /*
       * 白名单投影：只给名字 / 是否目录 / 大小（+ 可选 mtime）—— 端口实现多给的一律丢掉。
       * 与 §7-⑥ 的纪律一致：**不要**把端口层对象（可能带着绝对路径、权限位）直接下行。
       */
      const all: FileEntryDTO[] = raw
        .filter((entry) => !!entry.name && entry.name !== '.' && entry.name !== '..')
        .map((entry) => ({
          name: entry.name,
          isDir: entry.isDir,
          size: entry.isDir ? 0 : entry.size,
          ...(entry.mtimeMs != null ? { mtimeMs: entry.mtimeMs } : {}),
        }))
        .sort(compareFileEntries)
      const entries = all.slice(0, FILE_LIST_MAX_ENTRIES)
      const truncated = all.length > entries.length
      audit.record({
        method: 'host.file.list',
        allowed: true,
        sessionId: params.sessionId,
        detail: `${relPath || '/'} · ${entries.length} 项${truncated ? '（已截断）' : ''}`,
      })
      return { relPath, absPath, entries, ...(truncated ? { truncated: true } : {}) }
    },

    async readFile(params: FileReadParams): Promise<FileReadResult> {
      acl.assert(FILE_DOWNLOAD_CAPABILITY)
      assertLinkUsable(params.sessionId, 'host.file.read')
      requireWorkspace(params.sessionId)
      const relPath = normalizeRelPath(params.path)
      if (!relPath) throw new BridgeError('E_BAD_REQUEST', '必须指定文件路径')
      const absPath = await safePath(relPath, 'r', params.sessionId, 'host.file.read')
      // `statFile` 对目录 / 不存在都给 null —— 两种情形分别给更准确的错误码
      const stat = await files.statFile(absPath)
      if (!stat) {
        if (await files.exists(absPath)) {
          throw new BridgeError('E_BAD_REQUEST', `这是一个目录，不能按文件读取：${basenameForMessage(relPath)}`)
        }
        throw new BridgeError('E_NOT_FOUND', `文件不存在：${relPath}`)
      }
      const size = stat.size
      const offset = Math.max(0, Math.floor(params.offset ?? 0))
      const want = Math.max(1, Math.floor(params.length ?? FILE_CHUNK_BYTES))
      // 夹一层上限：单次请求的字节预算由电脑侧说了算（手机端传多少都不越界）
      const length = Math.min(want, FILE_CHUNK_BYTES)
      const bytes =
        offset >= size ? new Uint8Array(0) : await files.readRange(absPath, offset, length).catch((err) => {
          throw toBridgeError(err)
        })
      const name = basenameForMessage(relPath)
      return {
        data: bytesToBase64(bytes),
        offset,
        size,
        eof: offset + bytes.length >= size,
        // 分类与 MIME 由**电脑侧**给（手机端不靠自己的表猜）
        kind: previewKindOf(name),
        mime: mimeTypeOf(name),
        // 编辑保存的版本凭据（手机端打开时记下、保存时回传）——拿不到就整个字段缺席
        ...(stat.mtimeMs != null ? { mtimeMs: stat.mtimeMs } : {}),
      }
    },

    async beginFileWrite(params: FileWriteBeginParams): Promise<FileWriteBeginResult> {
      /*
       * 两条写入路径的**授权不同**，所以先看清是哪一种再 `assert`：
       * - 上传（往目录里新增）= `file.upload`；
       * - 覆写（编辑保存）  = `file.edit` —— 「能改已有文件」是另一档授权（那可能是源码）。
       * 用 `=== true` 而不是真值判断：旧手机端不传这个字段，缺省必须是上传。
       */
      const overwrite = params.overwrite === true
      acl.assert(overwrite ? FILE_EDIT_CAPABILITY : FILE_UPLOAD_CAPABILITY)
      assertLinkUsable(params.sessionId, 'host.file.write.begin')
      requireWorkspace(params.sessionId)
      const dir = normalizeRelPath(params.dir ?? '')
      if (!isSafeEntryName(params.name)) {
        throw new BridgeError('E_BAD_REQUEST', `文件名不合法：${params.name}`)
      }
      if (!Number.isFinite(params.size) || params.size < 0) {
        throw new BridgeError('E_BAD_REQUEST', '文件大小非法')
      }
      /*
       * 上限**按写入方式分开**，且都在开始前拒（手机端因此能立即告诉用户，而不是传到一半才失败）：
       * 编辑上限（256KB）比上传（32MB）严得多 —— 它是给源码 / 配置用的。
       */
      const maxBytes = overwrite ? FILE_EDIT_MAX_BYTES : FILE_UPLOAD_MAX_BYTES
      if (params.size > maxBytes) {
        throw new BridgeError(
          'E_BAD_REQUEST',
          `文件超过上限（${formatFileSize(maxBytes)}）：${formatFileSize(params.size)}`,
        )
      }
      const absDir = await safePath(dir, 'w', params.sessionId, 'host.file.write.begin')
      await requireDirectory(absDir, dir)
      const uploadId = `up-${Date.now().toString(36)}-${++uploadSeq}`
      /*
       * 临时文件名带 `.virlen-part` 后缀：真出意外时用户一眼能看出它不是自己的文件
       * （而不是凌晨两点对着一个「打开是坏的」的项目文件发懵）。
       */
      const tempPath = joinDir(absDir, `.virlen-upload-${uploadId}${UPLOAD_PART_SUFFIX}`)
      // 同名临时文件理论上不可能（uploadId 单调），但真存在就清掉，避免 append 到旧字节后面
      if (await files.exists(tempPath)) await files.remove(tempPath)

      if (overwrite) {
        const relPath = dir ? `${dir}/${params.name}` : params.name
        /*
         * 覆写的三道前置（与上传完全不同，逐条都是「宁可拒绝也别做错事」）：
         * ① 只收可编辑的类别 —— 手机端对图片 / 二进制没有编辑入口，这里再独立拒一次
         *    （入口是 UI 收敛，不是防线）；
         * ② 目标**必须已存在**（不存在 = 路径错了 → `E_NOT_FOUND`，**不新建**：手机端一个笔误
         *    不该在用户目录里凭空造出一个文件）；
         * ③ **必须带打开时的版本**（`expectMtimeMs`）—— 不给版本就不许覆写，于是「盲写」这条路
         *    根本不存在。
         */
        if (!isEditableFileName(params.name)) {
          throw new BridgeError('E_BAD_REQUEST', `这类文件不支持编辑：${params.name}`)
        }
        const absPath = joinDir(absDir, params.name)
        const stat = await files.statFile(absPath)
        if (!stat) {
          if (await files.exists(absPath)) {
            throw new BridgeError('E_BAD_REQUEST', `这是一个目录，不能覆写：${params.name}`)
          }
          throw new BridgeError('E_NOT_FOUND', `文件不存在：${relPath}`)
        }
        if (typeof params.expectMtimeMs !== 'number') {
          throw new BridgeError('E_BAD_REQUEST', '覆写必须带上打开文件时的版本（expectMtimeMs）')
        }
        /*
         * 冲突校验。为何必须有：从手机端打开这份文件到按保存之间可能过了几分钟，期间 AI / 用户 /
         * 编辑器都可能已经写过它 —— 不校验就等于把那些改动**静默吞掉**（用户毫无察觉）。
         * 拿不到 mtime（端口给不出）按冲突处理：确认不了版本就不改。
         */
        if (stat.mtimeMs == null || stat.mtimeMs !== params.expectMtimeMs) {
          audit.record({
            method: 'host.file.write.begin',
            allowed: false,
            sessionId: params.sessionId,
            detail: `${relPath} · 版本冲突（手机端持有的是旧版本）`,
          })
          throw new BridgeError('E_CONFLICT', '电脑上的这份文件已经变了，请重新载入后再改')
        }
        if (params.expectSize != null && params.expectSize !== stat.size) {
          throw new BridgeError('E_CONFLICT', '电脑上的这份文件已经变了，请重新载入后再改')
        }
        uploads.set(uploadId, {
          sessionId: params.sessionId,
          name: params.name,
          absPath,
          relPath,
          tempPath,
          declaredSize: params.size,
          received: 0,
          overwrite: true,
          baseMtimeMs: stat.mtimeMs,
          baseSize: stat.size,
        })
        audit.record({
          method: 'host.file.write.begin',
          allowed: true,
          sessionId: params.sessionId,
          detail: `覆写 ${relPath} · 申报 ${formatFileSize(params.size)}`,
        })
        return { uploadId, name: params.name, relPath, received: 0 }
      }

      /* ── 上传（新建）：同名冲突**在开始时就定名**，手机端因此能在动手前告诉用户最终名字 ── */
      if ((params.onConflict ?? 'rename') === 'reject' && (await files.exists(joinDir(absDir, params.name)))) {
        throw new BridgeError('E_CONFLICT', `同名文件已存在：${params.name}`)
      }
      const name = await resolveAvailableName(absDir, params.name)
      uploads.set(uploadId, {
        sessionId: params.sessionId,
        name,
        absPath: joinDir(absDir, name),
        relPath: dir ? `${dir}/${name}` : name,
        tempPath,
        declaredSize: params.size,
        received: 0,
      })
      audit.record({
        method: 'host.file.write.begin',
        allowed: true,
        sessionId: params.sessionId,
        detail: `${dir || '/'}/${name} · 申报 ${formatFileSize(params.size)}`,
      })
      return { uploadId, name, relPath: dir ? `${dir}/${name}` : name, received: 0 }
    },

    async writeFileChunk(params: FileWriteChunkParams): Promise<FileWriteChunkResult> {
      const upload = requireAuthorizedUpload(params.uploadId)
      assertLinkUsable(upload.sessionId, 'host.file.write.chunk')
      // 偏移必须与已接收字节数一致：乱序拼接换来的是一个「看起来成功了」的坏文件
      if (params.offset !== upload.received) {
        throw new BridgeError('E_CONFLICT', `分块偏移不对：期望 ${upload.received}，收到 ${params.offset}`)
      }
      let chunk: Uint8Array
      try {
        chunk = base64ToBytes(params.data)
      } catch (err) {
        throw new BridgeError('E_BAD_REQUEST', '分块数据不是合法的 base64', { cause: err })
      }
      if (chunk.length === 0) return { received: upload.received }
      if (chunk.length > FILE_CHUNK_BYTES) {
        throw new BridgeError('E_BAD_REQUEST', `分块超过上限（${formatFileSize(FILE_CHUNK_BYTES)}）`)
      }
      if (upload.received + chunk.length > upload.declaredSize) {
        throw new BridgeError('E_BAD_REQUEST', '写入字节数超过申报的文件大小')
      }
      await files.appendBytes(upload.tempPath, chunk).catch((err) => {
        throw toBridgeError(err)
      })
      upload.received += chunk.length
      return { received: upload.received }
    },

    async finishFileWrite(params: FileWriteFinishParams): Promise<FileWriteFinishResult> {
      const upload = requireAuthorizedUpload(params.uploadId)
      assertLinkUsable(upload.sessionId, 'host.file.write.finish')
      // 字节数不符就不落盘：申报 1MB 只收到 300KB 时，用户在电脑上得到的是一份坏文件
      if (upload.received !== upload.declaredSize) {
        throw new BridgeError(
          'E_BAD_REQUEST',
          `文件未传完：${formatFileSize(upload.received)}/${formatFileSize(upload.declaredSize)}`,
        )
      }
      uploads.delete(params.uploadId)
      const absDir = dirOfPath(upload.absPath)
      if (upload.overwrite) {
        /*
         * 覆写的收尾：**替换**目标（不是挑空位改名）。
         *
         * 落盘前**再校验一次版本** —— begin 与 finish 之间隔着网络（慢链路下几百毫秒到几秒），
         * AI 完全可能在这期间又写了一遍同一个文件。这一步把「吞掉别人改动」的窗口从
         * 「整条网络往返」缩到「两次系统调用之间」。
         */
        const stat = await files.statFile(upload.absPath)
        const changed =
          !stat ||
          stat.mtimeMs == null ||
          stat.mtimeMs !== upload.baseMtimeMs ||
          (upload.baseSize != null && stat.size !== upload.baseSize)
        if (changed) {
          await files.remove(upload.tempPath).catch(() => {})
          audit.record({
            method: 'host.file.write.finish',
            allowed: false,
            sessionId: upload.sessionId,
            detail: `${upload.relPath} · 落盘前发现版本已变（临时文件已丢弃）`,
          })
          throw new BridgeError('E_CONFLICT', '电脑上的这份文件刚刚又变了，请重新载入后再改')
        }
        await files.replaceFile(upload.tempPath, upload.absPath).catch(async (err) => {
          // 替换失败别把临时文件留在用户项目里；目标文件此时**保持原样**（rename 的原子性）
          await files.remove(upload.tempPath).catch(() => {})
          throw toBridgeError(err)
        })
        const after = await files.statFile(upload.absPath)
        audit.record({
          method: 'host.file.write.finish',
          allowed: true,
          sessionId: upload.sessionId,
          detail: `覆写 ${upload.relPath} · ${formatFileSize(upload.declaredSize)}`,
        })
        return {
          name: upload.name,
          relPath: upload.relPath,
          size: upload.declaredSize,
          // 回执带上新的版本：手机端连改两次时，第二次的校验得用这个值
          ...(after?.mtimeMs != null ? { mtimeMs: after.mtimeMs } : {}),
        }
      }
      /*
       * ── 上传（新建）的收尾 ──
       * 从定名到收尾之间目标可能**已被占用**（用户同时在电脑上存了同名文件）。
       * Windows 的 rename 对已存在的目标会直接失败 —— 与其报一个用户看不懂的 IO 错误，
       * 不如按同一条冲突口径再让一次名（并把这个新名字如实回给手机）。
       */
      const finalName = await resolveAvailableName(absDir, upload.name)
      const finalPath = joinDir(absDir, finalName)
      await files.rename(upload.tempPath, finalPath).catch(async (err) => {
        // 改名失败别把临时文件留在用户项目里
        await files.remove(upload.tempPath).catch(() => {})
        throw toBridgeError(err)
      })
      audit.record({
        method: 'host.file.write.finish',
        allowed: true,
        sessionId: upload.sessionId,
        detail: `${upload.relPath} · ${formatFileSize(upload.declaredSize)}`,
      })
      return {
        name: finalName,
        relPath: withName(upload.relPath, finalName),
        size: upload.declaredSize,
      }
    },

    /**
     * 放弃上传：删临时文件。
     *
     * ⚠️ **两道门都比别处松，且是有意的**：
     * - **不过非中继门槛**：链路刚被换成中继（或断了）时，恰恰最需要把临时文件清掉；
     *   在一个只做清理的动作上加链路门，只会把垃圾永久留在用户的目录里。
     * - **未知 `uploadId` 也算成功**：`abort` 是幂等的清理动作，调用方（手机端）在超时后
     *   重试一次不该收到一个错误。
     * 但 ACL 照旧 `assert` —— 那是授权，不是链路质量。
     */
    async abortFileWrite(params: FileWriteAbortParams): Promise<{ ok: true }> {
      const upload = uploads.get(params.uploadId)
      if (!upload) return { ok: true }
      acl.assert(upload.overwrite ? FILE_EDIT_CAPABILITY : FILE_UPLOAD_CAPABILITY)
      uploads.delete(params.uploadId)
      await files.remove(upload.tempPath).catch(() => {})
      audit.record({
        method: 'host.file.write.abort',
        allowed: true,
        sessionId: upload.sessionId,
        detail: `${upload.relPath} · 已放弃（收到 ${formatFileSize(upload.received)}）`,
      })
      return { ok: true }
    },
  }
}

/** 拼绝对路径（`/` 分隔；工作目录根时就是子项名）。 */
function joinDir(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '')
  return base ? `${base}/${name}` : name
}

/** 取所在目录（无目录部分 → 空串）。 */
function dirOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '' : normalized.slice(0, index)
}

/** 用新名字替换相对路径的末级（冲突消解后回给手机端的路径）。 */
function withName(relPath: string, name: string): string {
  const index = relPath.lastIndexOf('/')
  return index < 0 ? name : `${relPath.slice(0, index)}/${name}`
}

/** 错误文案里用的末级名（手机端要看得懂「哪个文件」）。 */
function basenameForMessage(relPath: string): string {
  return baseNameOfPath(relPath) || relPath
}
