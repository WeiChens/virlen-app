/**
 * useCodeDisplay —— 代码显示设置的响应式读取与落地。
 *
 * 两个出口，职责分开：
 *   · `useCodeDisplay()`：组件侧唯一入口，返回**已解析**的参数（主题 id / 字号 / 字族 / 行高 / 行号）。
 *     CodePreview / CodeEditor / MonacoDiffView / code-block 都从这里取值，禁止各自换算。
 *   · `useApplyCodeDisplay()`：全局落地，只在 App.tsx 挂一次 —— 写 `<html data-code-theme>` 与
 *     一份 `:root[data-code-theme]{--code-*}` 样式，供 DOM 侧（流式 `<pre>`、代码块外壳）使用。
 *
 * ⚠️ 本文件不引 monaco：主题由每个实例的 `theme` prop 落到 Monaco（@monaco-editor/react 挂载时
 *    与 prop 变更时都会调 `setTheme`，实测其默认值是 'light'，所以谁也不能省这个 prop）。
 *    这样 App 的入口包不会因为「设置代码主题」把 monaco 拉进首屏。
 */
import { useEffect, useState } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'
import {
  buildCodeCssVars,
  codeThemeOf,
  resolveCodeDisplay,
  type ResolvedCodeDisplay,
} from '@/domain/code-display'

/** 覆盖样式表的元素 id（与 useAccentColor 的 STYLE_ID 同一套做法：复用元素，不往 head 里堆） */
const STYLE_ID = 'virlen-code-theme'

/**
 * 当前应用明暗。
 *
 * 只读 `<html data-theme>`（useTheme 已经把它落好，含「跟随系统」时 OS 切档），
 * 不在这里重算 matchMedia —— 两边各算一次，早晚有一天会算出不同结果。
 */
export function currentAppTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'dark'
}

/**
 * reaction 的追踪表达式：只读真正影响代码显示的字段。
 *
 * `follow` 档才读 `theme`（条件读取）：fixed 档下切应用主题不该引起任何代码区重渲染。
 */
function trackedSlice(): unknown[] {
  const s = settingsState.value
  return [
    s.codeThemeMode,
    s.codeThemeId,
    s.codeFontSize,
    s.codeFontFamily,
    s.codeLineHeight,
    s.codeFontLigatures,
    s.codeShowLineNumbers,
    s.codeThemeMode === 'follow' ? s.theme : '',
  ]
}

function snapshot(): ResolvedCodeDisplay {
  return resolveCodeDisplay(settingsState.value, currentAppTheme())
}

/**
 * 两解析结果是否等价。
 *
 * 用它把「值没变」的情况挡在 setState 之前（返回旧对象 → React 直接 bail out）：
 * 应用主题一变 <html data-theme> 就会被观察者触发一次同步，fixed 档下代码区其实什么都没变，
 * 不该因此把每个 Monaco 的 options 重新算一遍（那会连带触发 updateOptions）。
 */
function sameDisplay(
  a: ResolvedCodeDisplay,
  b: ResolvedCodeDisplay,
): boolean {
  return (
    a.themeId === b.themeId &&
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.lineHeightPx === b.lineHeightPx &&
    a.fontFamily === b.fontFamily &&
    a.ligatures === b.ligatures &&
    a.showLineNumbers === b.showLineNumbers
  )
}

export function useCodeDisplay(): ResolvedCodeDisplay {
  const [resolved, setResolved] = useState<ResolvedCodeDisplay>(snapshot)

  useEffect(() => {
    const sync = () =>
      setResolved((prev) => {
        const next = snapshot()
        return sameDisplay(prev, next) ? prev : next
      })
    // 首次 effect 之前设置可能已经变了（父组件在同一帧里改过设置），先同步一次
    sync()

    const dispose = reaction(trackedSlice, sync)

    // 应用明暗由 <html data-theme> 承载：观察属性即可覆盖「跟随系统」那一档的 OS 切换
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(sync)
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      dispose()
      observer?.disconnect()
    }
  }, [])

  return resolved
}

/**
 * 把解析后的参数落到 DOM：`<html data-code-theme>` + 一份样式表。
 *
 * 选择器用 `:root[data-code-theme]`（特异性 0,2,0）：刚好压过 theme.scss 的
 * `[data-theme='dark']`（0,1,0），又与它的「切一个属性、零计算」口径一致。
 * 幂等：反复调用只重写同一个 `<style>` 的内容。
 */
export function applyCodeDisplay(display: ResolvedCodeDisplay): void {
  if (typeof document === 'undefined') return

  document.documentElement.setAttribute('data-code-theme', display.themeId)

  const vars = buildCodeCssVars(codeThemeOf(display.themeId), {
    fontSize: display.fontSize,
    lineHeight: display.lineHeight,
    fontFamily: display.fontFamily,
  })
  const body = Object.entries(vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')

  let el = document.getElementById(STYLE_ID)
  if (!(el instanceof HTMLStyleElement)) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = `:root[data-code-theme]{${body}}`
}

/** 全局落地（App.tsx 挂一次）：设置一变就重写属性与样式表 */
export function useApplyCodeDisplay(): void {
  const display = useCodeDisplay()
  useEffect(() => {
    applyCodeDisplay(display)
  }, [display])
}
