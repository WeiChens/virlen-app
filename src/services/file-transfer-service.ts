/**
 * file-transfer-service — 侧边栏文件操作（复制 / 粘贴 / 重命名 / 删除）
 *
 * 定位：这些动作是「安全校验 + 文件系统能力」的编排，与 UI 无关，
 * 所以放 services；文案与弹窗留给调用方 —— 与 `utils/clipboard.ts` 同一约定：
 * 本层只回答「成功没有 / 为什么失败」，由 UI 翻译成人话。
 *
 * 剪贴板语义（对齐资源管理器 / VS Code）：**应用内**文件剪贴板，
 * 复制只记住路径，粘贴时才真正落盘。刻意不碰系统剪贴板（Windows 上要写
 * CF_HDROP 才能互通，属于另一件事）。
 *
 * 另有一类「原位」操作：move（目录树里拖到别的目录下）。它与 paste 的区别是
 * 走 rename —— 原子、不产生副本、同名直接算失败。
 *
 * ⚠️ 铁律 6：所有**写**操作（粘贴目标、重命名、删除）必须先过
 *    `securityService.resolveSafePath(..., 'w')`，禁止绕过。
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { makeAutoObservable } from 'mobx'
import { securityService } from '@/services/security-service'

/** 操作结果：失败原因原样带回，由调用方决定怎么提示 */
export interface FileOpResult {
  ok: boolean
  /** 粘贴成功的条目数 */
  copied?: number
  /** 移动成功的条目数 */
  moved?: number
  /** 批量操作里失败的条目数（部分失败时 > 0） */
  failed?: number
  /** 移动时因同名而失败的名称（UI 据此提示「已存在同名项」） */
  conflict?: string[]
  /** 失败原因（多来自文件系统 / 安全校验） */
  error?: string
  /** 业务语义失败码，UI 据此给本地化文案 */
  code?: 'exists' | 'invalid-name' | 'invalid-target'
}

/**
 * 同名冲突时自动添加的后缀（与资源管理器的「 - 副本」一致）。
 * ⚠️ 它会成为磁盘上的文件名，故不进 i18n（同 ATTACHED_FILE_LABEL 的处理）。
 */
const DUPLICATE_SUFFIX = ' - 副本'

/** 生成唯一副本名的尝试上限 */
const MAX_DUPLICATE_TRIES = 100

/** 是否可用的文件系统（浏览器 dev / 单测环境下降级） */
function isTauriFsAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 路径分隔符统一成 /（与全项目其他路径一致） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 取所在目录（无目录部分时原样返回） */
export function parentDirOf(p: string): string {
  const normalized = normalizePath(p)
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? normalized : normalized.slice(0, idx)
}

/** 取路径末段 */
export function baseNameOf(p: string): string {
  const segments = normalizePath(p).split('/').filter(Boolean)
  return segments[segments.length - 1] || p
}

/**
 * 路径是否位于某个目录内（含该目录自身）。
 * Windows 的盘符与文件名大小写不敏感 → 一律按小写比较，避免 C:/WS 与 c:/ws 被判成「不在里面」。
 */
function isInsideDir(dir: string, p: string): boolean {
  const d = normalizePath(dir).toLowerCase()
  const target = normalizePath(p).toLowerCase()
  if (!d || !target) return false
  return target === d || target.startsWith(`${d}/`)
}

/**
 * 能否把这批条目移动到目标目录（纯函数，UI 用它决定拖拽落点是否高亮，move 内部再校验一次）。
 *
 * 拒绝两种落点：目标是源自身、目标在源目录内部（否则等于把目录搬进它自己里面）。
 * 「拖回原目录」不算违规 —— move 会把它当无操作跳过。
 */
export function canMoveInto(sources: string[], targetDir: string): boolean {
  if (!targetDir || sources.length === 0) return false
  return sources.every((src) => {
    if (!src) return false
    return !isInsideDir(src, targetDir)
  })
}

/** 拆分扩展名（`a.tar.gz` 只认最后一段，与资源管理器一致） */
function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

/** 目标已存在时往后找一个可用名：`a.txt` → `a - 副本.txt` → `a - 副本 (2).txt` */
async function resolveUniquePath(dir: string, name: string): Promise<string> {
  const candidate = `${dir}/${name}`
  if (!(await tauriFs.exists(candidate))) return candidate

  const { base, ext } = splitName(name)
  for (let i = 1; i <= MAX_DUPLICATE_TRIES; i++) {
    const suffix = i === 1 ? DUPLICATE_SUFFIX : `${DUPLICATE_SUFFIX} (${i})`
    const next = `${dir}/${base}${suffix}${ext}`
    if (!(await tauriFs.exists(next))) return next
  }
  throw new Error('too many duplicates')
}

/** 递归复制（目录先建目录再逐项下沉；文件直接 copyFile） */
async function copyRecursive(src: string, dest: string): Promise<void> {
  const info = await tauriFs.stat(src)
  if (info.isDirectory) {
    await tauriFs.mkdir(dest, { recursive: true })
    const entries = await tauriFs.readDir(src)
    for (const entry of entries) {
      if (!entry.name) continue
      await copyRecursive(`${src}/${entry.name}`, `${dest}/${entry.name}`)
    }
    return
  }
  // 目标父目录可能不存在（复制到新建目录时）→ 建好再拷
  await tauriFs.mkdir(parentDirOf(dest), { recursive: true }).catch(() => {})
  await tauriFs.copyFile(src, dest)
}

/**
 * 应用内文件剪贴板（observable）。
 * UI 依赖 `hasItems` 决定「粘贴」菜单项是否可用，故必须是响应式状态。
 */
class FileClipboard {
  /** 已复制的路径（绝对路径，分隔符为 /） */
  paths: string[] = []

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
  }

  get hasItems(): boolean {
    return this.paths.length > 0
  }

  set(paths: string[]): void {
    this.paths = paths.map((p) => normalizePath(p))
  }

  clear(): void {
    this.paths = []
  }
}

export const fileClipboard = new FileClipboard()

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export const fileTransferService = {
  /**
   * 复制到应用内剪贴板。
   * 只记路径、不落盘，因此无需安全校验（真正的写发生在 paste）。
   */
  copy(paths: string[]): void {
    fileClipboard.set(paths)
  },

  /**
   * 把剪贴板里的条目复制进目标目录。
   * 同名冲突自动加「 - 副本」，不覆盖既有文件。
   */
  async paste(
    targetDir: string,
    sessionId?: string,
  ): Promise<FileOpResult> {
    if (!isTauriFsAvailable()) {
      return { ok: false, error: 'not a tauri environment' }
    }
    const sources = fileClipboard.paths
    if (sources.length === 0) return { ok: false, error: 'clipboard is empty' }

    try {
      // 写操作先过安全校验（目标目录）
      const dir = normalizePath(
        await securityService.resolveSafePath(targetDir, 'w', sessionId),
      )
      let copied = 0
      for (const src of sources) {
        // 源路径按只读校验（与 copy_move_file 工具一致）
        await securityService.resolveSafePath(src, 'r', sessionId)
        const name = baseNameOf(src)
        if (!name) continue
        const dest = await resolveUniquePath(dir, name)
        await copyRecursive(normalizePath(src), dest)
        copied++
      }
      if (copied === 0) return { ok: false, error: 'nothing copied' }
      return { ok: true, copied }
    } catch (e) {
      return { ok: false, error: errorText(e) }
    }
  },

  /**
   * 把多个条目移动到目标目录（目录树拖拽落盘）。
   *
   * 走 `rename`：原子、不覆盖、不生成副本 —— 目标同名即算失败（与资源管理器一致）。
   * 比 paste 多两道校验：
   *  - 源所在目录也要写权限（移动会同时改源 / 目标两个目录的元数据）；
   *  - 拒绝落到源自身或其子目录（见 canMoveInto）。
   */
  async move(
    paths: string[],
    targetDir: string,
    sessionId?: string,
  ): Promise<FileOpResult> {
    if (!isTauriFsAvailable()) {
      return { ok: false, error: 'not a tauri environment' }
    }
    const sources = paths.map(normalizePath).filter(Boolean)
    if (sources.length === 0) return { ok: false, error: 'nothing to move' }
    if (!canMoveInto(sources, targetDir)) {
      return { ok: false, code: 'invalid-target', error: 'invalid target' }
    }

    try {
      // 写操作先过安全校验（目标目录）
      const dir = normalizePath(
        await securityService.resolveSafePath(targetDir, 'w', sessionId),
      )
      let moved = 0
      let failed = 0
      let firstError = ''
      const conflict: string[] = []

      for (const src of sources) {
        const name = baseNameOf(src)
        try {
          const dest = `${dir}/${name}`
          // 源按只读校验（与 copy_move_file 工具一致）
          await securityService.resolveSafePath(src, 'r', sessionId)
          if (dest === src) {
            // 拖回原目录：不会有任何变化
            moved++
            continue
          }
          await securityService.resolveSafePath(
            parentDirOf(src),
            'w',
            sessionId,
          )
          await securityService.resolveSafePath(dest, 'w', sessionId)
          if (await tauriFs.exists(dest)) {
            failed++
            conflict.push(name)
            continue
          }
          await tauriFs.rename(src, dest)
          moved++
        } catch (e) {
          failed++
          if (!firstError) firstError = errorText(e)
        }
      }

      if (moved === 0) {
        return {
          ok: false,
          moved,
          failed,
          conflict: conflict.length ? conflict : undefined,
          error: firstError || 'move failed',
          code: conflict.length ? 'exists' : undefined,
        }
      }
      return {
        ok: true,
        moved,
        failed: failed || undefined,
        conflict: conflict.length ? conflict : undefined,
      }
    } catch (e) {
      return { ok: false, error: errorText(e) }
    }
  },

  /** 重命名（保持所在目录不变）。名称非法 / 目标已存在时给出失败码。 */
  async rename(
    path: string,
    newName: string,
    sessionId?: string,
  ): Promise<FileOpResult> {
    if (!isTauriFsAvailable()) {
      return { ok: false, error: 'not a tauri environment' }
    }
    const name = newName.trim()
    if (!name || /[/\\]/.test(name)) {
      return { ok: false, code: 'invalid-name', error: 'invalid name' }
    }

    try {
      const src = normalizePath(
        await securityService.resolveSafePath(path, 'r', sessionId),
      )
      const dest = `${parentDirOf(src)}/${name}`
      if (dest === src) return { ok: true }
      // 写操作先过安全校验（新路径同样要校验）
      await securityService.resolveSafePath(dest, 'w', sessionId)
      if (await tauriFs.exists(dest)) {
        return { ok: false, code: 'exists', error: 'target exists' }
      }
      await tauriFs.rename(src, dest)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorText(e) }
    }
  },

  /** 删除（移入系统回收站，可恢复） */
  async remove(path: string, sessionId?: string): Promise<FileOpResult> {
    if (!isTauriFsAvailable()) {
      return { ok: false, error: 'not a tauri environment' }
    }
    try {
      const target = normalizePath(
        await securityService.resolveSafePath(path, 'w', sessionId),
      )
      if (!(await tauriFs.exists(target))) {
        return { ok: false, error: 'path not found' }
      }
      await invoke('move_to_trash', { path: target })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorText(e) }
    }
  },
}
