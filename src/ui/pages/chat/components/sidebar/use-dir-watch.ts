/**
 * 「只盯展开的目录」：给侧边栏文件树用的监听钩子。
 *
 * 为什么按目录订阅、而不是盯整棵工作区：
 * 1. `node_modules` / `target` / `.git` 这种目录一遍就能刷出几千个事件，盯整棵树等于给主进程
 *    上满负载（VS Code 也是只盯「展开可见」的那些目录）；
 * 2. 非递归订阅本身就等价于「这一层的列表可能变了」，不需要区分是新增 / 删除 / 重命名。
 *
 * 展开集合变了只做**增量对齐**（新展开的订阅、折叠的退订），不整体重建 ——
 * 每次展开都把全部 watcher 拆了重建既浪费也会漏事件。
 *
 * 去抖交给插件：`tauriFs.watch` 的 `delayMs` 在 Rust 侧（notify-debouncer）合并同一批事件，
 * 一次保存 / 一次批量解压只会回调一次。
 */
import { useEffect, useRef } from 'react'
import * as tauriFs from '@tauri-apps/plugin-fs'

/** 插件侧防抖窗口：一次保存常冒 2~4 个事件，300ms 足够合并且体感是「立刻」 */
const WATCH_DELAY_MS = 300

interface WatchEntry {
  /** 目录已被折叠 / 组件已卸载：订阅回来时立刻退掉 */
  disposed: boolean
  stop: (() => void) | null
}

/**
 * @param dirs     要监听的目录（绝对路径）。调用方负责 `useMemo` 稳住引用。
 * @param onChanged 某个目录的内容变了（新增 / 删除 / 重命名 / 属性），参数是该目录
 */
export function useDirWatchers(
  dirs: string[],
  onChanged: (dir: string) => void,
): void {
  // 回调每帧都可能是新函数：走 ref，避免因为「换了个箭头函数」就把 watcher 全重建
  const callbackRef = useRef(onChanged)
  callbackRef.current = onChanged

  const watchersRef = useRef<Map<string, WatchEntry>>(new Map())

  useEffect(() => {
    const active = watchersRef.current
    const desired = new Set(dirs.filter(Boolean))

    // 折叠的：退订（用户口径：只监听展开的文件夹）
    for (const [dir, entry] of active) {
      if (desired.has(dir)) continue
      entry.disposed = true
      entry.stop?.()
      active.delete(dir)
    }

    // 新展开的：订阅
    for (const dir of desired) {
      if (active.has(dir)) continue
      const entry: WatchEntry = { disposed: false, stop: null }
      active.set(dir, entry)
      void (async () => {
        try {
          const stop = await tauriFs.watch(
            dir,
            () => callbackRef.current(dir),
            { delayMs: WATCH_DELAY_MS },
          )
          if (entry.disposed) stop()
          else entry.stop = stop
        } catch {
          // 订阅失败（没权限 / 目录已被删）→ 退回手动刷新，树其余功能不受影响。
          // 这个目录留在表里不再重试：反复重试只会刷屏，折叠再展开时会重新试一次。
        }
      })()
    }
  }, [dirs])

  // 卸载：收掉所有 watcher（dev 的 StrictMode 也会走到这里，不能省）
  useEffect(
    () => () => {
      const active = watchersRef.current
      for (const entry of active.values()) {
        entry.disposed = true
        entry.stop?.()
      }
      active.clear()
    },
    [],
  )
}
