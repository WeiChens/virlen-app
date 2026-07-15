import { invoke } from '@tauri-apps/api/core'

/**
 * 判断是不是空字符串。null，undefined，""，" "都会返回true
 * @param str
 * @returns
 */
export const isEmpty = (str: string) => {
  if (!str) return true
  if (typeof str == 'number') return false
  if (str.trim() == '') return true
  return false
}

/**
 * 判断是否全是中文
 * @param str
 * @returns
 */
export function isAllChinaLanguage(str: string) {
  let reg = /^[\u4E00-\u9FFF]+$/
  return reg.test(str)
}

/**
 * 是否是手机号码
 * @param phone
 * @returns
 */
export function isPhone(phone: string) {
  return /^(13[0-9]|14[01456879]|15[0-35-9]|16[2567]|17[0-8]|18[0-9]|19[0-35-9])\d{8}$/.test(
    phone,
  )
}
/**
 * 是否是手机号码(全球范围)
 * @param phone
 * @returns
 */
export function isGlobalPhone(phone: string) {
  return /(\d{1,4})\s?\d{1,4}-?\d{1,9}$/.test(phone)
}
/**
 * 获取随机ID
 */
export const UUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export const ToJSON = (obj: any) => JSON.stringify(obj)

/**
 * 时间格式化
 * @param date
 * @param fmt
 * @returns
 */
export const dateFormat = (date: Date, fmt = 'yyyy-MM-dd hh:mm:ss') => {
  var o = {
    'M+': date.getMonth() + 1, //月份
    'd+': date.getDate(), //日
    'h+': date.getHours(), //小时
    'm+': date.getMinutes(), //分
    's+': date.getSeconds(), //秒
    'q+': Math.floor((date.getMonth() + 3) / 3), //季度
    S: date.getMilliseconds(), //毫秒
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

/**
 * 深拷贝一个对象 注意:函数无法拷贝
 * @param o
 * @returns
 */
export const copyObject = <T>(o: T): T => JSON.parse(JSON.stringify(o))

/**
 * 睡眠函数
 * @param time 睡眠时间（毫秒）
 */
export const sleep = (time = 200): Promise<true> =>
  new Promise((r, _) => setTimeout(() => r(true), time))

/**
 * 密码加密
 * @param str
 * @returns
 */
export function decToHex(str: string) {
  var res = []
  for (var i = 0; i < str.length; i++)
    res[i] = ('00' + str.charCodeAt(i).toString(16)).slice(-4)
  return '\\u' + res.join('\\u')
}
/**
 * 密码解密
 * @param str
 * @returns
 */
export function hexToDec(str: string) {
  str = str.replace(/\\/g, '%')
  return unescape(str)
}
/**
 * 判断是不是网址
 * @param str
 * @returns
 */
export function isURL(str: string) {
  // 匹配域名（含 localhost）的 URL
  const urlRegex =
    /^(https?:\/\/)([\w.-]+(?:\.[a-zA-Z]{2,})?|localhost)(:\d{1,5})?(\/[\w\.-]*)*\/?$/i
  // 匹配 IP 地址的 URL（含路径和端口）
  const ipIP =
    /^(https?:\/\/)((25[0-5]|2[0-4]\d|[01]?\d{1,2})\.){3}(25[0-5]|2[0-4]\d|[01]?\d{1,2})(:\d{1,5})?(\/[\w\.-]*)*\/?$/
  return urlRegex.test(str.trim()) || ipIP.test(str.trim())
}

/**
 * 创建一个Date对象，主要是解决苹果端无法用 yyyy-MM-dd的格式创建对象
 * @param res
 * @returns
 */
export const newDate = (res: any) => {
  if (typeof res == 'string') {
    return new Date(res.replace(/[-]/g, '/'))
  }
  return new Date(res)
}

/**
 * 如果的一个参数为 null或0或空字符串，就会返回第二个参数
 * @param value
 * @param exists 兜底值
 * @returns 最后的值
 */
export function ifUnExists<T>(value: T, exists: T): T {
  if (typeof value == 'string' && value.trim() == '') {
    return exists
  }
  if (!value) {
    return exists
  }
  return value
}

/**
 * 是否是邮箱
 * @param email
 * @returns
 */
export const isEmail = (email: string) =>
  /^[a-zA-Z0-9._%±]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}$/.test(email)

/**
 * 解析网址参数
 * @param {string} url
 * @returns
 */
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
/**
 * 根据年月获取日数
 * @param year
 * @param months
 * @returns
 */
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
 * 将对象转换为 FormData
 * @param obj
 * @returns
 */
export function objectToFormData(obj: any) {
  const formData = new FormData()
  appendFormData(formData, obj)
  return formData
}

/**
 * 节流函数 - 确保函数在指定时间内最多执行一次
 * @param fn 需要节流的函数
 * @param wait 等待时间（毫秒）
 * @param immediate 是否立即执行
 * @returns 节流后的函数
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
/**
 * 压缩图片文件
 */
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
    canvas2.getContext('2d').putImageData(imageData, 0, 0)
    canvas2.toBlob(
      (blob) => {
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
  f = Math.round(num * Math.pow(10, n)) / Math.pow(10, n) // n 幂
  let s = f.toString()
  let rs = s.indexOf('.')
  //判定如果是整数，增加小数点再补0
  if (rs < 0) {
    rs = s.length
    s += '.'
  }
  while (s.length <= rs + n) {
    s += '0'
  }
  return s
}
/**
 * 尝试解析 JSON 字符串
 * @param str
 * @param defaultValue
 * @returns
 */
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
/**
 * 列表分组
 * @param list
 * @param groupKey
 * @returns
 */
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

/**
 * 获取url文件名
 * @param url url
 * @param defaultName 默认文件名
 * @returns
 */
export function getUrlFileName(url: string, defaultName = 'download') {
  if (!url) return defaultName
  const fileName = url
    .split(/(\\)|[/]/)
    .pop()
    .split('?')[0]
    .trim()
  return fileName || defaultName
}

/**
 * 将绝对路径转为相对路径（相对于工作目录）
 * @param absolutePath 绝对路径
 * @param workspace 工作目录，不传则从 settingsState 读取
 * @returns 如果在工作目录下返回相对路径，否则返回原路径
 */
export function toShortPath(absolutePath: string, workspace?: string): string {
  if (!absolutePath) return absolutePath
  const base = workspace
  if (!base) return absolutePath
  // 统一正斜杠
  const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedPath === normalizedBase) return '.'
  if (normalizedPath.startsWith(normalizedBase + '/')) {
    return normalizedPath.slice(normalizedBase.length + 1)
  }
  return absolutePath
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

/**
 * 格式化时间为相对时间显示
 * @param date 要格式化的日期对象
 * @returns 格式化后的时间字符串
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date()

  // 计算时间差（毫秒）
  const diffMs = date.getTime() - now.getTime()
  const diffSeconds = Math.floor(Math.abs(diffMs) / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  // 判断是否同一年
  const isSameYear = date.getFullYear() === now.getFullYear()

  // 判断是否同一天
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  // 判断是否在同一周（以周一为一周开始）
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

  // 获取小时和分钟
  const hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const timeStr = `${hours}:${minutes === '00' ? '' : minutes}`

  // 如果是未来时间
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

  // 如果是过去时间
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
    // 判断是否是昨天
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
  const rect = canvas.getBoundingClientRect() // 获取元素在视口中的位置和尺寸
  const scaleX = canvas.width / rect.width // 实际绘图宽度与CSS宽度的比例
  const scaleY = canvas.height / rect.height // 实际绘图高度与CSS高度的比例
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
let _platform: 'windows' | 'macos' | 'linux' = null

/**
 * 检测当前操作系统平台。
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
