/**
 * i18n 多语言工具 —— 以中文为 key，代码里直接写 t("你好")。
 *
 * 工作方式：zh-CN 直接返回 key（零运行时开销）；en-US 从 lang/{lang}.json 查翻译，找不到返回 key（中文兜底）。
 * 启动时序：① main.tsx init() 调 initI18n() 提前同步加载；② App.tsx useLanguage() 只监听语言变化；③ 组件 t() 直接用。
 */

import { useEffect, useState } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'

export type Language = 'zh-CN' | 'en-US'

/** 缓存已加载的语言包 */
const loadedMessages: Partial<Record<Language, Record<string, string>>> = {}

/**
 * 加载指定语言的翻译包（内部方法）。
 */
async function loadMessages(lang: Language): Promise<Record<string, string>> {
  if (loadedMessages[lang]) return loadedMessages[lang]!
  try {
    const messages = await import(`./lang/${lang}.json`)
    loadedMessages[lang] = messages.default || messages
    return loadedMessages[lang]!
  } catch {
    console.warn(`[i18n] Failed to load language pack: ${lang}`)
    return {}
  }
}

/** 当前已加载的语言 */
let currentLang: Language = 'zh-CN'
/** 当前语言的翻译包 */
let currentMessages: Record<string, string> = {}

/**
 * 初始化 i18n（在 main.tsx init() 阶段调用）：提前加载语言包，确保 React 渲染时 t() 可直接使用。
 */
export async function initI18n(): Promise<void> {
  await ensureLanguageReady(settingsState.value.language as Language)
}

/**
 * 确保语言包已加载，并把 currentLang / currentMessages 切到该语言（幂等）。
 *
 * 为什么需要：语言切换的「生效」发生在 useLanguage() 的 reaction 里，它要 await import(...) 才拿到新包 ——
 * 切换瞬间**同步**调 t() 的代码（如要推给原生侧的托盘文案）会拿到旧语言。需要「立即用新语言」的调用方先 await 本函数。
 */
export async function ensureLanguageReady(
  lang: Language = settingsState.value.language as Language,
): Promise<void> {
  currentLang = lang
  if (lang === 'zh-CN') {
    currentMessages = {}
    return
  }
  currentMessages = await loadMessages(lang)
}

/**
 * 获取当前语言。
 */
export function getCurrentLanguage(): Language {
  return currentLang
}

/**
 * 翻译函数。
 * @param key 中文文本（同时也是翻译 key）；@param fallback 可选兜底，不传则返回 key 本身
 */
export function t(key: string, fallback?: string): string {
  if (currentLang === 'zh-CN') return key
  return currentMessages[key] ?? fallback ?? key
}

/**
 * 模板翻译函数：翻译文本里用 `$__变量名__` 作占位符（中文 key 与英文翻译可各自排语序）。
 *
 * @param params 变量字典，如 { count: 3 }
 */
export function tpl(key: string, params: Record<string, string | number>): string {
  // 1. 获取翻译文本（中文环境直接返回 key 本身）
  const template = currentLang === 'zh-CN' ? key : (currentMessages[key] ?? key)
  // 2. 替换所有 $__变量名__ 占位符
  return template.replace(/\$__(\w+)__/g, (_, name: string) => {
    const val = params[name]
    return val !== undefined ? String(val) : `$__${name}__`
  })
}

/**
 * React Hook：监听语言变化触发组件重渲染（App.tsx 中调一次即全局生效）。语言包已在 init() 中提前加载，此处只负责切换时更新。
 */
export function useLanguage() {
  const [, setTick] = useState(0)

  useEffect(() => {
    // 首次渲染时已无需加载，直接触发一次确保 t() 返回值正确
    setTick((n) => n + 1)

    // 监听语言变化
    const dispose = reaction(
      () => settingsState.value.language,
      async (newLang: string) => {
        const lang = newLang as Language
        currentLang = lang
        if (lang === 'zh-CN') {
          currentMessages = {}
        } else {
          currentMessages = await loadMessages(lang)
        }
        setTick((n) => n + 1) // 触发重渲染
      },
    )

    return () => dispose()
  }, [])
}
