/**
 * Tauri 版文件系统端口（§37 的生产实现）—— `FileSystemPort` 的真身。
 *
 * 与 `file-source.ts` 的分工：**那一层管纪律**（带宽上限、临时文件、越权路径规整、ACL），
 * 本文件只管「本机的文件系统怎么读写」。分开的收益是 `file-source.ts` 的全部纪律都能在没有
 * Tauri 的环境里被单测（注入内存端口），而这里剩下的只有 API 形状的适配。
 *
 * ## 为什么读取要 `open + seek + read` 而不是 `readFile`
 *
 * `plugin-fs.readFile()` 把**整个文件**读进内存：手机上点开一个 500MB 的视频，webview 先 OOM，
 * 而我们只要前 256KB。分块读取必须靠文件句柄（`seek` 到偏移再读一段），
 * 于是 `capabilities/default.json` 里开了 `fs:allow-open` 与 `fs:allow-seek`
 * —— 前者不带范围，实际边界由 `fs:scope`（`**`）与本层传入的**已过安全校验的绝对路径**共同决定。
 *
 * ## 为什么写入用 `append: true` 而不是自己维护偏移
 *
 * 临时文件是**只追加**的（`begin` 建、`chunk` 追加、`finish` 改名）。让系统调用负责定位，
 * 我们只保证「按顺序、按已接收字节数」地追加 —— 顺序性由 `file-source.ts` 校验
 * （`offset` 必须等于已接收字节数），两层合起来才等于「写进去的字节就是传出去的字节」。
 *
 * ## 覆写（编辑保存）为什么是 `rename` 覆盖，而不是「删了再写」
 *
 * `rename` 覆盖目标是一个**原子**动作，而「先删目标、再把临时文件改过去」会在两次调用之间留下一个
 * 「文件不存在」的窗口 —— 用户的编辑器 / 构建工具完全可能正好在那个窗口里读到 404。
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
     * 列目录（非递归）。
     *
     * 走 Rust `list_directory`（与桌面文件树 / `list_files` 工具**同一个实现**）：一次调用
     * 就能拿到「名字 + 是否目录 + 大小」，比 `readDir` 之后逐个 `stat` 少一圈 IPC。
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
     * 大小 + 修改时刻；不存在或不是文件 → `null`（调用方据此给 `E_NOT_FOUND` / `E_BAD_REQUEST`）。
     *
     * `mtime` 是**编辑保存的版本凭据**（见 `file-source.ts` 的纪律 6）：`plugin-fs` 的 `stat` 给的是
     * `Date | null`，这里统一成 ms 时间戳；拿不到就给 `null`，调用方会 fail-closed（不改）。
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
     * 读一段字节。
     *
     * `read()` 在文件尾返回 `null`（不是 0），且**允许少于请求长度**（短读），
     * 所以这里循环到填满或遇到 EOF —— 少读一次就是「文件末尾少了几个字节」这种查不出来的坏文件。
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
     * 替换目标（目标已存在则覆盖）。
     *
     * 与 `rename` 是**同一个系统调用**，但契约不同（见 `FileSystemPort`）：`rename` 的调用方已经
     * 挑好了一个空位，而这里的调用方明确要覆盖一个已存在的文件。Windows 上 `fs::rename` 走
     * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，**目标正被其它进程占着时仍会失败** —— 那就报错，
     * 由上层清掉临时文件（目标保持原样，这正是「先写临时文件」的意义）。
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
