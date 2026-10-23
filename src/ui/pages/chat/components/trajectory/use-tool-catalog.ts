/**
 * 轨迹检查器「工具」页的装载器：把**本会话可见的工具定义**接进只读的轨迹视图。
 *
 * 两条纪律：
 * - 过滤只走 domain 的 `filterAllowedToolDefs`（三态白名单语义只有一份实现，见该文件）；
 * - 惰性：只有真的打开系统记录（`enabled`）时才读契约 —— 轨迹的其它行不该为它付 IPC。
 */
import { useEffect, useRef, useState } from 'react'
import { filterAllowedToolDefs, toolRegistry } from '@/domain/tools'
import type { ResolvedToolDefinition } from '@/domain/tools/types'

export interface ToolCatalogState {
  tools: readonly ResolvedToolDefinition[]
  /** 定义还在路上（首次打开时最多一帧） */
  loading: boolean
  /** 读取失败的原因（加载器未注入 / IPC 报错）；正常为 null */
  error: string | null
}

const IDLE: ToolCatalogState = { tools: [], loading: false, error: null }

export function useToolCatalog(
  allowedTools: readonly string[] | undefined,
  enabled: boolean,
): ToolCatalogState {
  const [state, setState] = useState<ToolCatalogState>(IDLE)
  // 白名单换了个新数组不该重载：真正决定结果的只有名单内容
  const allowedKey = allowedTools === undefined ? '*' : JSON.stringify(allowedTools)
  const allowedRef = useRef(allowedTools)
  allowedRef.current = allowedTools

  useEffect(() => {
    if (!enabled) {
      setState(IDLE)
      return
    }
    let alive = true
    setState({ tools: [], loading: true, error: null })
    toolRegistry
      .listDefinitions()
      .then((defs) => {
        if (!alive) return
        setState({
          tools: filterAllowedToolDefs(defs, allowedRef.current),
          loading: false,
          error: null,
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        setState({
          tools: [],
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        })
      })
    return () => {
      alive = false
    }
  }, [enabled, allowedKey])

  return state
}
