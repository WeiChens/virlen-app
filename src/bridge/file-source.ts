/**
 * 工作目录文件接口层：手机端浏览 / 预览 / 下载 / 上传 / 编辑本机文件。
 *
 * 六条纪律：
 * 1. 越权防线只有一道（resolvePath），本文件不得自己拼路径；
 * 2. 非中继：仅拒确认走 relay 的链路（unknown 放行），abort 例外；
 * 3. 分块：单次 RPC 最多 FILE_CHUNK_BYTES，上界即内存上界；
 * 4. 写入先落临时文件，finish 才落盘；
 * 5. 每一步独立 assert（手机端不显示入口不等于隔离）；
 * 6. 覆写与上传共用同一条分块通道，覆写需目标已存在 + 版本校验（begin 与 finish 各一次）。
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

/** 本接口层实现的六个方法。 */
export type HostFiles = Pick<
  HostDataSource,
  | 'listFiles'
  | 'readFile'
  | 'beginFileWrite'
  | 'writeFileChunk'
  | 'finishFileWrite'
  | 'abortFileWrite'
>

/** 一条目录条目（端口层形状，协议 DTO 在 files.ts 组装）。 */
export interface FileSysEntry {
  name: string
  isDir: boolean
  size: number
  mtimeMs?: number
}

/**
 * 文件系统端口（真正碰磁盘的一层）：隔开后纪律逻辑可在无 Tauri 环境完整单测。
 */
export interface FileSystemPort {
  /** 列目录（非递归） */
  listDir(dir: string, options: { includeHidden: boolean }): Promise<FileSysEntry[]>
  /**
   * 文件大小与修改时刻（不存在 / 是目录 → null）。mtimeMs 是编辑保存的版本凭据，
   * 拿不到即编辑不可用（fail-closed）。
   */
  statFile(path: string): Promise<{ size: number; mtimeMs: number | null } | null>
  /** 是否目录（不存在 → false） */
  isDirectory(path: string): Promise<boolean>
  /** 是否存在（文件或目录都算） */
  exists(path: string): Promise<boolean>
  /** 读一段字节（越界部分按实际长度返回） */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>
  /** 追加写（目标不存在则创建，只增不改） */
  appendBytes(path: string, bytes: Uint8Array): Promise<void>
  /** 改名（上传收尾：临时文件 → 目标名） */
  rename(from: string, to: string): Promise<void>
  /**
   * 替换目标（已存在则覆盖）。与 rename 分开：rename 要求目标不存在，
   * 这里用于编辑保存的收尾（合成一步可避免「先删再改」的中间窗口）。
   */
  replaceFile(from: string, to: string): Promise<void>
  /** 删除文件（清理临时文件；不存在不报错） */
  remove(path: string): Promise<void>
}

export interface HostFilesDeps {
  acl: Acl
  audit: AuditLog
  /** 文件系统端口（生产 = Tauri；测试 = 内存） */
  files: FileSystemPort
  /**
   * 路径安全校验（与桌面文件工具同一入口）。不传 = 每个方法报 E_UNSUPPORTED：
   * 没有安全校验的文件接口不该有默认实现。
   */
  resolvePath?: (input: string, mode: 'r' | 'w', sessionId: string) => Promise<string>
  /** 会话工作目录；null = 会话不存在 */
  workspaceOf?: (sessionId: string) => string | null
  /** 当前链路通讯类型（非中继门槛）；不传 = 不限制 */
  linkKind?: () => LinkKind
}

/** 一次进行中的写入（finish / abort 后即消失）。 */
interface Upload {
  sessionId: string
  /** 目标文件名（冲突消解后的最终名） */
  name: string
  /** 目标绝对路径 */
  absPath: string
  /** 相对工作目录的路径（回给手机显示） */
  relPath: string
  /** 临时文件绝对路径 */
  tempPath: string
  /** 手机申报的总大小 */
  declaredSize: number
  /** 已接收字节数（也是下一块的期望偏移） */
  received: number
  /** true = 覆写已有文件（编辑保存）；缺省 = 上传新建 */
  overwrite?: boolean
  /** 覆写时手机端声明「打开时就是这个版本」，finish 前再校验一次 */
  baseMtimeMs?: number
  baseSize?: number
}

/** 冲突消解最多往后找几个候选名 */
const MAX_DUPLICATE_TRIES = 100

export function createHostFiles(deps: HostFilesDeps): HostFiles {
  const { acl, audit, files } = deps
  const uploads = new Map<string, Upload>()
  let uploadSeq = 0

  /** 会话工作目录（归一化）；不存在 → E_NOT_FOUND */
  const requireWorkspace = (sessionId: string): string => {
    const workspace = normalizeWorkspace(deps.workspaceOf?.(sessionId))
    if (!workspace) throw new BridgeError('E_NOT_FOUND', `会话不存在：${sessionId}`)
    return workspace
  }

  /** 安全解析：相对工作目录 → 绝对路径 + 黑白名单校验 */
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
       * 安全校验拒绝 → E_DENIED：resolveSafePath 抛的是普通 Error（还要服务桌面文件工具），
       * 不归的话手机端会把正常的越权拒绝看成「电脑端内部错误」。文案保留原样。
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

  /** 非中继门槛：命中即留痕再抛（否则「点不动」无从查证） */
  const assertLinkUsable = (sessionId: string, method: string): void => {
    const reason = deps.linkKind ? fileTransferDeniedReason(deps.linkKind()) : null
    if (!reason) return
    audit.record({ method, allowed: false, sessionId, detail: reason })
    throw new BridgeError('E_DENIED', reason)
  }

  /** 冲突消解：a.txt → a - 副本.txt → a - 副本 (2).txt */
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
   * 取在途写入并校验授权：授权按这条记录自己的写入方式算（覆写 = file.edit，新建 = file.upload）。
   */
  const requireAuthorizedUpload = (uploadId: string): Upload => {
    const upload = requireUpload(uploadId)
    acl.assert(upload.overwrite ? FILE_EDIT_CAPABILITY : FILE_UPLOAD_CAPABILITY)
    return upload
  }

  /** 目录必须存在（否则给明确结论，而不是空列表） */
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
       * 白名单投影：只给名字 / 是否目录 / 大小（+ mtime），不把端口层对象（可能带绝对路径、
       * 权限位）直接下行。
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
      // statFile 对目录 / 不存在都给 null —— 两种情形分别给更准确的错误码
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
      // 夹一层上限：单次字节预算由电脑侧说了算
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
        // 分类与 MIME 由电脑侧给（手机端不靠自己的表猜）
        kind: previewKindOf(name),
        mime: mimeTypeOf(name),
        // 编辑保存的版本凭据；拿不到就整个字段缺席
        ...(stat.mtimeMs != null ? { mtimeMs: stat.mtimeMs } : {}),
      }
    },

    async beginFileWrite(params: FileWriteBeginParams): Promise<FileWriteBeginResult> {
      /*
       * 两种写入的授权不同：上传 = file.upload，覆写 = file.edit（可能是源码）。
       * 用 === true：旧手机端不传这个字段，缺省必须是上传。
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
       * 上限按写入方式分开且都在开始前拒：编辑 256KB，上传 32MB。
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
       * 临时文件名带 .virlen-part 后缀：真出意外时用户一眼能看出它不是自己的文件。
       */
      const tempPath = joinDir(absDir, `.virlen-upload-${uploadId}${UPLOAD_PART_SUFFIX}`)
      // 同名临时文件理论不可能（uploadId 单调），真存在就清掉，避免追加到旧字节后
      if (await files.exists(tempPath)) await files.remove(tempPath)

      if (overwrite) {
        const relPath = dir ? `${dir}/${params.name}` : params.name
        /*
         * 覆写的三道前置：① 只收可编辑类别（入口收紧不是防线）；② 目标必须已存在（笔误
         * 不该凭空造文件）；③ 必须带打开时版本，盲写这条路根本不存在。
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
         * 冲突校验：从打开到保存可能过了几分钟，期间可能已被写过 —— 不校验就是静默吞掉别人的改动。
         * 拿不到 mtime 按冲突处理。
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

      /* ── 上传（新建）：同名冲突在开始时定名，手机端能在动手前告诉用户最终名字 ── */
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
      // 偏移必须与已接收字节一致：乱序拼接换来的是一个「看着成功」的坏文件
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
      // 字节数不符就不落盘（否则用户得到一份坏文件）
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
         * 覆写收尾：替换目标。落盘前再校验一次版本 —— begin 与 finish 之间隔着网络，
         * AI 完全可能在这期间又写过一遍。
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
          // 替换失败别把临时文件留在项目里；目标文件此时保持原样
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
          // 回执带新版本：手机端连改两次时第二次要用这个值
          ...(after?.mtimeMs != null ? { mtimeMs: after.mtimeMs } : {}),
        }
      }
      /*
       * 上传收尾：从定名到收尾之间目标可能已被占用（Windows 的 rename 会失败），
       * 按同一冲突口径再让一次名，并把新名字如实回给手机。
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
     * 放弃上传：删临时文件。不过非中继门槛（链路刚变中继时正是最需要清理的时候），
     * 未知 uploadId 也算成功（幂等）。ACL 照旧 assert。
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

/** 拼绝对路径（/ 分隔；工作目录根时就是子项名） */
function joinDir(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '')
  return base ? `${base}/${name}` : name
}

/** 取所在目录（无目录部分 → 空串） */
function dirOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '' : normalized.slice(0, index)
}

/** 用新名字替换相对路径的末级 */
function withName(relPath: string, name: string): string {
  const index = relPath.lastIndexOf('/')
  return index < 0 ? name : `${relPath.slice(0, index)}/${name}`
}

/** 错误文案里用的末级名 */
function basenameForMessage(relPath: string): string {
  return baseNameOfPath(relPath) || relPath
}
