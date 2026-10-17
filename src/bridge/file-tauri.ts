/**
 * Tauri 版文件系统端口（FileSystemPort 的生产实现）：只管「本机读写」，纪律（带宽上限、临时文件、
 * 越权路径、ACL）全在 `file-source.ts`，故那边可无 Tauri 单测。
 * 读取用 open + seek + read 而不用 readFile（后者把整个文件读进内存）；复写用 rename（原子）而非先删再写。
 */
import { invoke } from '@tauri-apps/api/core'
import * as tauriFs from '@tauri-apps/plugin-fs'
import type { FileSysEntry, FileSystemPort } from './file-source'

/** Rust `list_directory` 返回的结构化条目（`search::DirEntry`）。 */
interface RustDirEntry {
  name: string
  type: 'file' | 'dir' | 'enter_dir' | 'leave_dir'
  size?: number | null
}

let listSeq = 0

/** 建一份 Tauri 文件端口。调用方（bridge 装配）每次装配一份即可，内部无状态。 */
export function createTauriFileSystem(): FileSystemPort {
  return {
    /**
     * 列目录（非递归）。走 Rust `list_directory`（与文件树 / `list_files` 同一实现），一次拿全字段。
     */
    async listDir(dir: string, options: { includeHidden: boolean }): Promise<FileSysEntry[]> {
      const raw: RustDirEntry[] = await invoke('list_directory', {
        root: dir,
        recursive: false,
        includeHidden: options.includeHidden,
        maxDepth: 1,
        // 手机端浏览不套用桌面「忽略沙盒命令」的那套目录跳过规则：用户要看的就是这个目录本身
        skipEachDirs: [],
        taskId: `phone_list_${Date.now().toString(36)}_${++listSeq}`,
      })
      const entries: FileSysEntry[] = []
      for (const item of raw) {
        // 非递归调用不该出现 enter_dir / leave_dir；真出现了就跳过（防御，不是常态）
        if (item.type === 'enter_dir' || item.type === 'leave_dir') continue
        if (!item.name) continue
        entries.push({
          name: item.name,
          isDir: item.type === 'dir',
          size: typeof item.size === 'number' ? item.size : 0,
        })
      }
      return entries
    },

    /**
     * 大小 + mtime；不存在或不是文件 → `null`。`mtime` 是编辑保存的版本凭据（`file-source` 纪律 6），
     * 拿不到传 `null`，调用方 fail-closed。
     */
    async statFile(path: string): Promise<{ size: number; mtimeMs: number | null } | null> {
      try {
        const info = await tauriFs.stat(path)
        if (info.isDirectory || !info.isFile) return null
        return {
          size: typeof info.size === 'number' ? info.size : 0,
          mtimeMs: info.mtime ? info.mtime.getTime() : null,
        }
      } catch {
        return null
      }
    },

    async isDirectory(path: string): Promise<boolean> {
      try {
        return (await tauriFs.stat(path)).isDirectory
      } catch {
        return false
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        return await tauriFs.exists(path)
      } catch {
        return false
      }
    },

    /**
     * 读一段字节。`read()` 到文件尾返回 `null` 且**允许短读**，故必须循环到填满或 EOF。
     */
    async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
      const handle = await tauriFs.open(path, { read: true })
      try {
        await handle.seek(offset, tauriFs.SeekMode.Start)
        const buffer = new Uint8Array(length)
        let filled = 0
        while (filled < length) {
          const read = await handle.read(buffer.subarray(filled))
          if (read == null || read <= 0) break
          filled += read
        }
        return filled === buffer.length ? buffer : buffer.subarray(0, filled)
      } finally {
        await handle.close().catch(() => {})
      }
    },

    async appendBytes(path: string, bytes: Uint8Array): Promise<void> {
      await tauriFs.writeFile(path, bytes, { append: true, create: true })
    },

    async rename(from: string, to: string): Promise<void> {
      await tauriFs.rename(from, to)
    },

    /**
     * 覆写目标。与 `rename` 同一系统调用，但契约是「目标已存在」：Windows 上目标被占仍会失败，
     * 那就报错、由上层清临时文件（目标保持原样 —— 这正是「先写临时文件」的意义）。
     */
    async replaceFile(from: string, to: string): Promise<void> {
      await tauriFs.rename(from, to)
    },

    /** 删除（用于清理临时文件）：不存在**不算失败**，清理动作必须幂等。 */
    async remove(path: string): Promise<void> {
      try {
        if (!(await tauriFs.exists(path))) return
        await tauriFs.remove(path)
      } catch {
        /* 清理失败不改变调用方的结论：用户可见的结果是「上传没成功」，临时文件残留另行排查 */
      }
    },
  }
}
