/**
 * useServiceList — 后台服务的轮询（入口徽标与面板的**唯一数据源**）。
 *
 * 两种范围（P4）：`sessionId` 是字符串 = 本会话（已选中会话时的口径）；`null` = **全局**
 *（聊天页处于「新对话」时的入口 —— 列出所有会话的服务，每行自带 `sessionId` 归属）。
 * 两者节奏一致，只换查询命令。
 *
 * 为什么不订阅事件：服务的状态变化点分散在读任务 / 等待任务 / 工具 / 面板四处，其中「进程自己退出」
 * 发生在常驻任务里（那里拿不到工具上下文的 sink），为它拉一条跨 crate 的事件通道不划算 ——
 * 单会话条目上限 8 条，一次轮询就是一帧 IPC。节奏：
 * - 面板打开 1s（用户正看着：运行时长 / 未读字符 / 谁刚死掉都要跟得上）；
 * - 只留入口 5s（只为徽标上那个数字）；
 * - 窗口不可见（切托盘 / 最小化）时**不发请求**，只保留节奏 —— 没人看着就不花这个 IPC。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listAllBackgroundServices,
  listBackgroundServices,
  type BackgroundServiceInfo,
} from '@/infrastructure/backgroundService'

/** 面板打开时的刷新间隔（ms） */
const FAST_MS = 1000
/** 只留入口时的刷新间隔（ms） */
const SLOW_MS = 5000

export interface ServiceListState {
  services: BackgroundServiceInfo[]
  /** 立刻对一次账（面板里终止完服务后调用，不等下一个 tick） */
  refresh: () => Promise<void>
}

export function useServiceList(
  sessionId: string | null,
  fast: boolean,
): ServiceListState {
  const [services, setServices] = useState<BackgroundServiceInfo[]>([])
  // 两个 ref 让「正在跑的循环」读到最新值，而不必因为面板开关 / 换会话而重建循环
  const fastRef = useRef(fast)
  fastRef.current = fast
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const refresh = useCallback(async () => {
    const sid = sessionRef.current
    const rows = sid
      ? await listBackgroundServices(sid)
      : await listAllBackgroundServices()
    setServices(rows)
  }, [])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // 换会话先清空：否则徽标会短暂显示上一个会话的数字
    setServices([])

    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        const rows = sessionId
          ? await listBackgroundServices(sessionId)
          : await listAllBackgroundServices()
        if (!alive) return
        setServices(rows)
      }
      timer = setTimeout(tick, fastRef.current ? FAST_MS : SLOW_MS)
    }

    timer = setTimeout(tick, 0)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId])

  return { services, refresh }
}
