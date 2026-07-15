/**
 * i18n 多语言工具
 *
 * 设计理念：以中文为 key，代码中直接写 t("你好")，一目了然。
 *
 * 工作方式：
 *   - 中文环境（zh-CN）：直接返回 key 本身，零运行时开销
 *   - 英文环境（en-US）：从 en-US.json 中查找翻译，找不到则返回 key（中文兜底）
 *   - 可扩展：新增语言只需添加对应的 JSON 文件
 *
 * 启动时序：
 *   1. main.tsx init() → 调用 initI18n() 提前加载语言包（同步完成）
 *   2. App.tsx useLanguage() → 只负责监听语言变化，不再重复加载
 *   3. 各组件 t() → 直接使用已就绪的语言包
 */

import { useEffect, useState } from 'react'
import { reaction } from 'mobx'
import { settingsState } from '@/ui/store/settingStore'

export type Language = 'zh-CN' | 'en-US'

/** 缓存已加载的语言包 */
const loadedMessages: Partial<Record<Language, Record<string, string>>> = {}

/**
 * 加载指定语言的翻译包（内部方法）
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
 * 初始化 i18n（在 main.tsx init() 阶段调用）
 *
 * 提前加载语言包，确保 React 渲染时 t() 可直接使用。
 * 中文环境直接返回 key，无需加载 JSON。
 */
export async function initI18n(): Promise<void> {
  const lang = settingsState.value.language as Language
  currentLang = lang
  if (lang === 'zh-CN') {
    currentMessages = {}
    return
  }
  currentMessages = await loadMessages(lang)
}

/**
 * 获取当前语言
 */
export function getCurrentLanguage(): Language {
  return currentLang
}

/**
 * 翻译函数
 *
 * @param key 中文文本（同时也是翻译 key）
 * @param fallback 可选兜底文本，不传则返回 key 本身
 * @returns 翻译后的文本
 *
 * @example
 *   t("你好")        // 中文环境 → "你好"，英文环境 → "Hello"
 *   t("你好", "Hi") // 英文环境未找到时 → "Hi"，而非 "你好"
 */
export function t(key: string, fallback?: string): string {
  if (currentLang === 'zh-CN') return key
  return currentMessages[key] ?? fallback ?? key
}

/**
 * 模板翻译函数 —— 支持带变量的翻译模板
 *
 * 在翻译文本中使用 $__变量名__ 作为占位符，
 * 中文 key 和英文翻译中可各自按语序排列变量位置。
 *
 * @param key   中文模板（同时也是翻译 key），如 "已删除 $__count__ 个会话"
 * @param params 变量字典，如 { count: 3 }
 * @returns 替换变量后的翻译文本
 *
 * @example
 *   tpl("已删除 $__count__ 个会话", { count: 3 })
 *   // 中文 → "已删除 3 个会话"
 *   // 英文 → "Deleted 3 conversations"
 *
 *   tpl("确定删除「$__name__」？$__reason__", { name: "xxx", reason: "此操作不可撤销。" })
 *   // 中文 → "确定删除「xxx」？此操作不可撤销。"
 *   // 英文 → "Are you sure you want to delete "xxx"? This action cannot be undone."
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
 * React Hook：监听语言变化，触发组件重渲染
 *
 * 在 App.tsx 中调用一次即可（全局生效）。
 * 语言包已在 main.tsx init() 中提前加载完毕，
 * 此 hook 只负责在用户切换语言时更新翻译并触发重渲染。
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
