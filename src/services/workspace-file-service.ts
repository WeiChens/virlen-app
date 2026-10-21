/**
 * 工作目录文件面板的数据层：**读取（文本 / 媒体）/ 保存文本**。
 *
 * 三条口径：
 * 1. **读写都要过安全校验**：与侧边栏其它文件操作同一套 `securityService.resolveSafePath`，
 *    黑名单目录里的文件在这里就被拒（面板只负责把原因显示出来）；
 * 2. **文本走 Rust**：`read_file_with_hash` 带编码嗅探（UTF-8 / GBK / UTF-16…），
 *    前端的 `TextDecoder` 做不到；媒体走 plugin-fs 读字节，再交给 `<img>` / `<audio>` / `<video>`；
 * 3. **保存前比对磁盘 hash**：面板里的内容可能是几分钟前读的，期间编辑器 / AI / 终端都可能改过它 ——
 *    不一致就报冲突，而不是把别人的改动覆盖掉；
 * 4. **监听正在看的那个文件**（`watchWorkspaceFile`）：只管「磁盘变了」这件事，怎么合并进编辑器
 *    由面板决定（干净 → 最小编辑刷进去；脏 → 黄条，不覆盖）。
 */
import { invoke } from '@tauri-apps/api/core'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { securityService } from '@/services/security-service'
import { computeContentHash10 } from '@/infrastructure/tools/file/common'
import { mimeOf, previewKindOf, type FilePreviewKind } from '@/domain/files/preview'

/** 文本上限：再大就不是「看一眼改两行」，Monaco 也会开始卡 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** 媒体上限：整份读进内存再转 blob URL，太大直接把 webview 拖死 */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024

/** 失败原因（面板据此给本地化文案；`blocked` 直接显示原始原因） */
export type WorkspaceFileErrorCode =
  | 'too-large'
  | 'not-found'
  | 'not-file'
  | 'conflict'
  | 'binary'
  | 'blocked'

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceFileError'
  }
}

/** Rust `stat_path` 的返回（不存在时为 null） */
interface PathStat {
  exists: boolean
  is_file: boolean
  size: number
}

/** Rust `read_file_with_hash` 的返回 */
interface FileReadResult {
  content: string
  hash10: string
  line_count: number
  byte_size: number
}

export interface LoadedTextFile {
  kind: 'text'
  content: string
  hash10: string
  byteSize: number
  lineCount: number
}

export interface LoadedMediaFile {
  kind: Exclude<FilePreviewKind, 'text' | 'other'>
  /** 原样字节：面板自己造 blob URL（卸载时负责 revoke） */
  bytes: Uint8Array
  mime: string
  byteSize: number
}

export interface LoadedOtherFile {
  kind: 'other'
  byteSize: number
}

export type LoadedWorkspaceFile =
  | LoadedTextFile
  | LoadedMediaFile
  | LoadedOtherFile

function nameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

/** 按扩展名判定打开方式，并读回内容（文本 → 字符串，媒体 → 字节） */
export async function loadWorkspaceFile(
  path: string,
  sessionId?: string,
): Promise<LoadedWorkspaceFile> {
  const fullPath = await securityService.resolveSafePath(path, 'r', sessionId)
  const stat = await invoke<PathStat | null>('stat_path', { path: fullPath })

  if (!stat?.exists) {
    throw new WorkspaceFileError('not-found', `文件不存在：${fullPath}`)
  }
  if (!stat.is_file) {
    throw new WorkspaceFileError('not-file', `不是文件：${fullPath}`)
  }

  const name = nameOf(fullPath)
  const kind = previewKindOf(name)

  if (kind === 'text') {
    if (stat.size > MAX_TEXT_BYTES) {
      throw new WorkspaceFileError('too-large', '文本文件超过 2 MB')
    }
    try {
      const result = await invoke<FileReadResult>('read_file_with_hash', {
        path: fullPath,
      })
      return {
        kind: 'text',
        content: result.content,
        hash10: result.hash10,
        byteSize: result.byte_size,
        lineCount: result.line_count,
      }
    } catch (error) {
      // Rust 侧对二进制 / 未知编码会拒绝：这不是「打不开」，是「这篇不该在编辑器里打开」
      throw new WorkspaceFileError('binary', messageOf(error))
    }
  }

  if (kind === 'other') {
    return { kind: 'other', byteSize: stat.size }
  }

  if (stat.size > MAX_MEDIA_BYTES) {
    throw new WorkspaceFileError('too-large', '媒体文件超过 64 MB')
  }

  const bytes = await tauriFs.readFile(fullPath)
  return {
    kind,
    bytes,
    mime: mimeOf(name),
    byteSize: stat.size,
  }
}

/** 比较用的路径键：统一分隔符 + 小写（Windows / macOS 大小写不敏感） */
function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** 父目录（保留原分隔符：路径要原样交给系统 API） */
function parentDirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  // 顶层（`/a.txt`、`E:/a.txt`）没有可用的父目录 → 交给调用方退回监听文件本身
  return index > 0 ? path.slice(0, index) : ''
}

/**
 * 监听**单个文件**的变化（只用于面板里「正在看的那个文件」）。
 *
 * 三个关键选择：
 * 1. **盯父目录而不是文件本身**：编辑器 / git / 脚本保存常是「写临时文件 + rename」，
 *    inotify 跟的是 inode，文件被替换后原来那只 watch 不再有任何事件（Linux / macOS 上是真事）。
 *    目录事件再按文件名过滤 —— VS Code 也是这么做的。
 * 2. **非递归**：只关心同目录里这一个文件的落盘，不订阅整棵工作区。
 * 3. **`delayMs` 交给插件在 Rust 侧防抖**：一次保存常冒出 2~4 个事件（写入 / 重命名 / 属性），
 *    这里再叠一层只会让刷新更迟钝。
 *
 * 返回取消函数；监听失败（权限 / 目录不存在）由调用方决定是否降级 —— 面板的选择是
 * 「退回手动刷新」，功能不受影响。
 */
export async function watchWorkspaceFile(
  path: string,
  onChange: () => void,
  sessionId?: string,
): Promise<() => void> {
  const fullPath = await securityService.resolveSafePath(path, 'r', sessionId)
  const target = pathKey(fullPath)
  const dir = parentDirOf(fullPath)

  return await tauriFs.watch(
    dir || fullPath,
    (event) => {
      for (const changed of event.paths) {
        // 只认这个文件本身：同一轮保存里目录也会出事件，不能拿它当「内容变了」
        if (pathKey(String(changed)) === target) {
          onChange()
          return
        }
      }
    },
    { delayMs: 300 },
  )
}

/**
 * 保存文本：先确认磁盘那版还是我们读的那版（hash 相同），再整文件写入。
 *
 * ⚠️ 写入走 plugin-fs（UTF-8）。原文件若是 GBK 等编码，保存后编码会变成 UTF-8 ——
 * 内容不变、字节变化；这是「在应用内编辑」与「保持原编码」之间必须选一个的地方。
 */
export async function saveWorkspaceText(
  path: string,
  content: string,
  baselineHash: string,
  sessionId?: string,
): Promise<{ hash10: string; lineCount: number; byteSize: number }> {
  const fullPath = await securityService.resolveSafePath(path, 'w', sessionId)

  let currentHash: string
  try {
    const current = await invoke<FileReadResult>('read_file_with_hash', {
      path: fullPath,
    })
    currentHash = current.hash10
  } catch {
    // 读不到（被删 / 被锁 / 变成二进制）→ 不能盖写
    throw new WorkspaceFileError('conflict', '文件已无法读取，可能已被移走或改动')
  }
  if (currentHash !== baselineHash) {
    throw new WorkspaceFileError('conflict', '文件已被其他程序修改')
  }

  await tauriFs.writeTextFile(fullPath, content)

  const normalized = content.replace(/\r\n/g, '\n')
  return {
    hash10: await computeContentHash10(content),
    // 与 Rust `read_file` 的 `.lines().count()` 同口径（末尾换行不再多算一行）：
    // `split('\n')` 会多出尾部空段 → 保存后行号 +1、刷新又变回去
    lineCount: normalized === '' ? 0 : normalized.replace(/\n$/, '').split('\n').length,
    byteSize: new TextEncoder().encode(content).length,
  }
}
