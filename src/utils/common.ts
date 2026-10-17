import { invoke } from '@tauri-apps/api/core'
import { isValidElement, ReactNode } from 'react'

export const isEmpty = (str: string) => {
  if (!str) return true
  if (typeof str == 'number') return false
  if (str.trim() == '') return true
  return false
}

export function isAllChinaLanguage(str: string) {
  let reg = /^[\u4E00-\u9FFF]+$/
  return reg.test(str)
}

export function isPhone(phone: string) {
  return /^(13[0-9]|14[01456879]|15[0-35-9]|16[2567]|17[0-8]|18[0-9]|19[0-35-9])\d{8}$/.test(
    phone,
  )
}
export function isGlobalPhone(phone: string) {
  return /(\d{1,4})\s?\d{1,4}-?\d{1,9}$/.test(phone)
}
export const UUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export const ToJSON = (obj: any) => JSON.stringify(obj)

/** fmt 默认 yyyy-MM-dd hh:mm:ss */
export const dateFormat = (date: Date, fmt = 'yyyy-MM-dd hh:mm:ss') => {
  var o = {
    'M+': date.getMonth() + 1,
    'd+': date.getDate(),
    'h+': date.getHours(),
    'm+': date.getMinutes(),
    's+': date.getSeconds(),
    'q+': Math.floor((date.getMonth() + 3) / 3),
    S: date.getMilliseconds(),
  }
  if (fmt == null) {
    return date.toDateString()
  }
  if (/(y+)/.test(fmt))
    fmt = fmt.replace(
      RegExp.$1,
      (date.getFullYear() + '').substr(4 - RegExp.$1.length),
    )
  //@ts-ignore
  for (var k in o)
    if (new RegExp('(' + k + ')').test(fmt))
      fmt = fmt.replace(
        RegExp.$1,
        // @ts-ignore
        RegExp.$1.length == 1 ? o[k] : ('00' + o[k]).substr(('' + o[k]).length),
      )
  return fmt
}

export const copyObject = <T>(o: T): T => JSON.parse(JSON.stringify(o))

export const sleep = (time = 200): Promise<true> =>
  new Promise((r, _) => setTimeout(() => r(true), time))

/** 字符串各字符的码位转成 \uXXXX 序列（非加密）。 */
export function decToHex(str: string) {
  var res = []
  for (var i = 0; i < str.length; i++)
    res[i] = ('00' + str.charCodeAt(i).toString(16)).slice(-4)
  return '\\u' + res.join('\\u')
}
export function hexToDec(str: string) {
  str = str.replace(/\\/g, '%')
  return unescape(str)
}
/** 是否是网址（含域名 / IP / localhost）。 */
export function isURL(str: string) {
  // 域名（含 localhost）
  const urlRegex =
    /^(https?:\/\/)([\w.-]+(?:\.[a-zA-Z]{2,})?|localhost)(:\d{1,5})?(\/[\w\.-]*)*\/?$/i
  // IP 地址
  const ipIP =
    /^(https?:\/\/)((25[0-5]|2[0-4]\d|[01]?\d{1,2})\.){3}(25[0-5]|2[0-4]\d|[01]?\d{1,2})(:\d{1,5})?(\/[\w\.-]*)*\/?$/
  return urlRegex.test(str.trim()) || ipIP.test(str.trim())
}

/** 苹果端不支持用 yyyy-MM-dd 创建 Date，这里换成分隔符。 */
export const newDate = (res: any) => {
  if (typeof res == 'string') {
    return new Date(res.replace(/[-]/g, '/'))
  }
  return new Date(res)
}

export function ifUnExists<T>(value: T, exists: T): T {
  if (typeof value == 'string' && value.trim() == '') {
    return exists
  }
  if (!value) {
    return exists
  }
  return value
}

export const isEmail = (email: string) =>
  /^[a-zA-Z0-9._%±]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}$/.test(email)

export function parseUrl(url: string) {
  if (!url.includes('?')) {
    return {
      path: url.split('://')[1],
      query: {},
    }
  }
  const querystring = url.split('?')[1]
  const path = url.split('?')[0].split('://')[1]
  const query: any = {}
  querystring.split('&').forEach((item) => {
    const [key, value] = item.split('=')
    query[key] = value
  })
  return {
    path,
    query,
  }
}
/** 闰年判定不能只靠 %4（整百年需 %400） */
export const getMonthDates = (year: number, months: number) => {
  const arr = [1, 3, 5, 7, 8, 10, 12]
  if (arr.includes(months)) return 31
  if (months != 2) return 30
  if (year % 4 != 0) return 28
  if (year % 100 == 0) return year % 400 == 0 ? 29 : 28
  return 29
}
export const isPhoneEquipment = () => {
  return /Android|webOS|iPhone|iPod|BlackBerry/i.test(navigator.userAgent)
}
export const debounce = (fn: Function, delay: number) => {
  let timer: any = null
  return function (...args: any) {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      fn(...args)
    }, delay)
  }
}
export function createResolvablePromise<T = any>() {
  let resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: any) => void
  const p = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // @ts-ignore
  return [p, resolve, reject] as const
}
export const isHttpURL = (url: string) => {
  return /^https?:\/\//.test(url)
}
export const stylesList = (styles: any, className: string) => {
  return className
    .split(' ')
    .map((item) => styles[item])
    .join(' ') as string
}

export const developing = () => {
  import('@/ui/components/shared/Toast').then((m) =>
    m.showToast('功能开发中,敬请期待'),
  )
}
export function htmlDecode(str: string) {
  const textarea = document.createElement('textarea')
  textarea.innerHTML = str
  return textarea.value
}

const defineCilpboard = {
  readText: async () => {
    return new Promise((resolve, _) => {
      const textarea = document.createElement('textarea')
      textarea.style.position = 'fixed'
      textarea.style.top = '0'
      textarea.style.left = '0'
      textarea.style.width = '2em'
      textarea.style.height = '2em'
      textarea.style.padding = '0'
      textarea.style.border = 'none'
      textarea.style.outline = 'none'
      textarea.style.boxShadow = 'none'
      textarea.style.background = 'transparent'
      document.body.appendChild(textarea)
      textarea.focus()
      document.execCommand('paste')
      const text = textarea.value
      document.body.removeChild(textarea)
      resolve(text)
    })
  },
  writeText: async (text: string) => {
    return new Promise((resolve, reject) => {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        resolve(null)
      } catch (e) {
        reject(e)
      }
    })
  },
}
export function getClipboard() {
  if (navigator.clipboard) return navigator.clipboard
  return defineCilpboard
}
function appendFormData(formData: FormData, data: any, parentKey = '') {
  if (data && typeof data === 'object' && !(data instanceof File)) {
    Object.keys(data).forEach((key) => {
      const propName = parentKey ? `${parentKey}[${key}]` : key
      appendFormData(formData, data[key], propName)
    })
  } else {
    formData.append(parentKey, data == null ? '' : data)
  }
}
/**
 * 将对象转换为 FormData。
 */
export function objectToFormData(obj: any) {
  const formData = new FormData()
  appendFormData(formData, obj)
  return formData
}

/**
 * 节流函数 —— 确保函数在指定时间内最多执行一次。
 * @param wait 等待时间（毫秒）；@param immediate 是否首次立即执行
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  wait: number = 300,
  immediate: boolean = false,
): (...args: Parameters<T>) => void {
  let timer: number | null = null
  let lastTime = 0

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now()

    if (immediate && !lastTime) {
      fn.apply(this, args)
      lastTime = now
      return
    }

    if (now - lastTime >= wait) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      fn.apply(this, args)
      lastTime = now
    } else if (!timer) {
      timer = setTimeout(
        () => {
          fn.apply(this, args)
          lastTime = Date.now()
          timer = null
        },
        wait - (now - lastTime),
      ) as any
    }
  }
}
/** 压缩图片文件（居中裁成 size×size 的 jpeg）。 */
export function compressImage(file: File, size = 200) {
  const [p, resolve, reject] = createResolvablePromise<File>()
  const reader = new FileReader()
  reader.readAsDataURL(file)
  reader.onload = async function () {
    const img = new Image()
    img.src = reader.result as string
    await img.decode()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx == null) {
      reject('ctx is null')
      return
    }
    let width = img.naturalWidth
    let height = img.naturalHeight
    let drawX = 0,
      drawY = 0
    let scale = 1
    if (width > height) {
      drawY = 0
      drawX = (width - height) / 2
      scale = height / size
    } else {
      drawX = 0
      drawY = (height - width) / 2
      scale = width / size
    }
    canvas.width = img.naturalWidth / scale
    canvas.height = img.naturalHeight / scale
    ctx.drawImage(
      img,
      0,
      0,
      img.naturalWidth,
      img.naturalHeight,
      0,
      0,
      img.naturalWidth / scale,
      img.naturalHeight / scale,
    )
    const imageData = ctx.getImageData(
      drawX / scale,
      drawY / scale,
      canvas.width - drawX / scale,
      canvas.height - drawY / scale,
    )
    const canvas2 = document.createElement('canvas')
    canvas2.width = size
    canvas2.height = size
    canvas2.getContext('2d')?.putImageData(imageData, 0, 0)
    canvas2.toBlob(
      (blob) => {
        if (!blob) {
          reject('blob is null')
          return
        }
        const file = new File([blob], 'compressed.jpeg', { type: 'image/jpeg' })
        resolve(file)
      },
      'image/jpeg',
      0.8,
    )
  }
  reader.onerror = reject
  return p
}

export function typeTransform<T, E>(f: (t: T) => E) {
  return (t: T) => f(t)
}
// num为传入的值，n为保留的小数位
export function fomatFloat(num: number | string, n = 2) {
  if (typeof num === 'string') {
    num = parseFloat(num)
  }
  let f = num
  if (isNaN(f)) {
    return false
  }
  f = Math.round(num * Math.pow(10, n)) / Math.pow(10, n)
  let s = f.toString()
  let rs = s.indexOf('.')
  // 整数：补小数点与 n 位 0
  if (rs < 0) {
    rs = s.length
    s += '.'
  }
  while (s.length <= rs + n) {
    s += '0'
  }
  return s
}
/** 尝试解析 JSON 字符串，失败返回 defaultValue。 */
export function tryParseJson(str: string, defaultValue: any = null) {
  if (!str) {
    return defaultValue
  }
  try {
    const value = JSON.parse(str)

    if (!value) {
      return defaultValue
    }
    return value
  } catch (e) {
    return defaultValue
  }
}
export function endsWith(str: string, suffix: string[]) {
  return suffix.some((s) => str.endsWith(s))
}
/** 列表按 groupKey 分组。 */
export function listGroup<T>(list: T[], groupKey: keyof T) {
  const groupList: {
    name: T[keyof T]
    list: T[]
  }[] = []
  list.forEach((item) => {
    const groupName = item[groupKey]
    const group = groupList.find((g) => g.name === groupName)
    if (group) {
      group.list.push(item)
    } else {
      groupList.push({ name: groupName, list: [item] })
    }
  })
  return groupList
}
export const canvasToBlob = (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string = 'image/png',
  quality: number = 0.92,
) => {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({
      type,
      quality,
    })
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('canvas 转换 blob 失败'))
        }
      },
      type,
      quality,
    )
  })
}

export function htmlToText(html: string) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

/** 从 URL 取文件名（取不到用 defaultName）。 */
export function getUrlFileName(url: string, defaultName = 'download') {
  if (!url) return defaultName
  const fileName = url
    .split(/(\\)|[/]/)
    ?.pop()
    ?.split('?')?.[0]
    ?.trim()
  return fileName || defaultName
}

/**
 * 为何必须归一：同一路径在两侧来源不同 —— 工作目录来自系统目录选择器，工具入参来自模型，
 * Rust 侧 canonicalize 还带扩展长度前缀，逐字符比较必然对不上。
 */
function normalizePathString(path: string): string {
  let p = path.replace(/\\/g, '/')
  // `\\?\C:/x` / `\\.\C:/x` → `C:/x`
  p = p.replace(/^\/\/[?.]\//, '')
  // 折叠重复斜杠：开头的 `//` 是 UNC（`//server/share`），必须留着
  p = p.startsWith('//')
    ? '//' + p.slice(2).replace(/\/{2,}/g, '/')
    : p.replace(/\/{2,}/g, '/')
  return p.replace(/\/+$/, '')
}

/** 形如 Windows 绝对路径（盘符或 UNC）—— 决定比较时是否忽略大小写 */
function isWindowsAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:(\/|$)/.test(p) || p.startsWith('//')
}

/**
 * 绝对路径 → 相对工作目录的路径；不在工作目录下则返回归一化后的原路径。
 * Windows 路径大小写不敏感，POSIX 敏感；返回值保留原大小写，统一用正斜杠。
 */
export function toShortPath(absolutePath: string, workspace?: string): string {
  if (!absolutePath) return absolutePath
  const path = normalizePathString(absolutePath)
  const base = workspace ? normalizePathString(workspace) : ''
  // 没有工作目录就无从截取；base 归一后为空串但确实给了工作目录（如 /）时继续比较
  if (!base && !workspace) return path

  const foldCase = isWindowsAbsolutePath(path) && isWindowsAbsolutePath(base)
  const cmpPath = foldCase ? path.toLowerCase() : path
  const cmpBase = foldCase ? base.toLowerCase() : base

  if (cmpPath === cmpBase) return '.'
  if (cmpPath.startsWith(cmpBase + '/')) {
    return path.slice(cmpBase.length + 1)
  }
  return path
}

/**
 * 相对路径 → 绝对路径（toShortPath 的逆操作）：openPath / revealItemInDir 只认绝对路径。
 * workspace 为空时原样返回（宁可不改，也不拼出错误路径）。
 */
export function toAbsolutePath(path: string, workspace?: string): string {
  if (!path) return path
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    return path
  }
  if (!workspace) return path
  const base = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return path
  // 去掉前导 ./，避免拼出 E:/ws/./a.ts 这种冗余段
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return `${base}/${rel}`
}

export function getFileParentDir(path: string) {
  path = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return path.substring(0, path.lastIndexOf('/'))
}
export const disableNotNumber = (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.key.match(/[^0-9]/g)) {
    if (
      e.key === 'Backspace' ||
      e.key === 'Delete' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Tab' ||
      e.key === 'Enter' ||
      e.key === 'Control' ||
      (e.ctrlKey &&
        (e.key === 'a' || e.key === 'c' || e.key === 'x' || e.key === 'v'))
    )
      return

    e.preventDefault()
  }
}

/** 相对时间：X 秒前 / 今日 h:mm / 周一 h:mm / 3月5日。 */
export function formatRelativeTime(date: Date): string {
  const now = new Date()

  const diffMs = date.getTime() - now.getTime()
  const diffSeconds = Math.floor(Math.abs(diffMs) / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  // 同一年 / 同一天
  const isSameYear = date.getFullYear() === now.getFullYear()

  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const isSameWeek = (() => {
    if (!isSameYear) return false

    const getWeekNumber = (d: Date): number => {
      const firstDayOfYear = new Date(d.getFullYear(), 0, 1)
      const pastDaysOfYear = Math.floor(
        (d.getTime() - firstDayOfYear.getTime()) / 86400000,
      )
      return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7)
    }

    return getWeekNumber(date) === getWeekNumber(now)
  })()

  // 获取星期几
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const weekday = weekdays[date.getDay()]

  const hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const timeStr = `${hours}:${minutes === '00' ? '' : minutes}`

  // 未来时间
  if (diffMs > 0) {
    if (diffMinutes < 1) {
      return `${diffSeconds}秒后`
    }
    if (diffHours < 1) {
      return `${diffMinutes}分钟后`
    }
    if (isSameDay) {
      return timeStr
    }
    if (isSameWeek) {
      return `${weekday} ${timeStr}`
    }
    if (isSameYear) {
      return `${date.getMonth() + 1}月${date.getDate()}日`
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }

  // 过去时间
  if (diffMinutes < 1) {
    return `${diffSeconds}秒前`
  }
  if (diffHours < 1) {
    return `${diffMinutes}分钟前`
  }
  if (diffDays < 1) {
    if (isSameDay) {
      return `今日 ${timeStr}`
    }
    // 昨天
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate()
    ) {
      return `昨天 ${timeStr}`
    }
  }
  if (isSameWeek) {
    return `${weekday} ${timeStr}`
  }
  if (isSameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}
export function getCanvasMousePosition(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
) {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width // 实际绘图宽度 / CSS 宽度
  const scaleY = canvas.height / rect.height
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  }
}
export function getMatch<T = any>(
  list: T[],
  matchCallback: (v: T) => boolean = (v) => !!v,
) {
  for (const item of list) {
    if (matchCallback(item)) {
      return item
    }
  }
  return null
}
let _platform: 'windows' | 'macos' | 'linux' | null = null

/**
 * 当前系统平台（Rust os_platform 权威，失败用 UA 兜底），进程内缓存。
 */
export async function getPlatform(): Promise<'windows' | 'macos' | 'linux'> {
  if (_platform) return _platform
  try {
    const platform = await invoke<string>('os_platform')
    if (platform === 'windows') _platform = 'windows'
    else if (platform === 'darwin' || platform === 'macos') _platform = 'macos'
    else _platform = 'linux'
    return _platform
  } catch {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    if (/Windows/i.test(ua)) _platform = 'windows'
    else if (/Mac/i.test(ua)) _platform = 'macos'
    else _platform = 'linux'
    return _platform
  }
}

export function extractReactNodeText(node: ReactNode, joinChar = ' '): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(n => extractReactNodeText(n, joinChar)).join(joinChar);
  }
  if (isValidElement(node)) {
    return extractReactNodeText((node.props as any)?.children, joinChar);
  }
  return '';
}
