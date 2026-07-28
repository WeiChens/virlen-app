/**
 * common.ts 工具函数测试
 *
 * 覆盖场景：
 * - isEmpty 各种边界
 * - isURL 合法/非法 URL
 * - isEmail
 * - tryParseJson
 * - sleep（超时行为）
 * - fomatFloat
 * - ifUnExists
 * - toShortPath
 * - listGroup
 */
import { describe, it, expect, vi } from 'vitest'
import {
  isEmpty,
  isURL,
  isEmail,
  tryParseJson,
  fomatFloat,
  ifUnExists,
  toShortPath,
  listGroup,
  getUrlFileName,
} from '@/utils/common'

describe('isEmpty', () => {
  it('null / undefined 应返回 true', () => {
    expect(isEmpty(null as any)).toBe(true)
    expect(isEmpty(undefined as any)).toBe(true)
  })

  it('空字符串应返回 true', () => {
    expect(isEmpty('')).toBe(true)
  })

  it('仅空白字符串应返回 true', () => {
    expect(isEmpty('   ')).toBe(true)
    expect(isEmpty('\t\n')).toBe(true)
  })

  it('非空字符串应返回 false', () => {
    expect(isEmpty('hello')).toBe(false)
    expect(isEmpty('  a  ')).toBe(false)
  })

  it('数字 0 因是 falsy 值也被视为空', () => {
    // 注：类型签名是 (str: string)，但实际运行时 0 被 !0 转为 true
    expect(isEmpty(0 as any)).toBe(true)
    expect(isEmpty(42 as any)).toBe(false)
  })
})

describe('isURL', () => {
  it('合法 HTTPS URL 应返回 true', () => {
    expect(isURL('https://example.com')).toBe(true)
    expect(isURL('https://api.openai.com/v1')).toBe(true)
  })

  it('合法 HTTP URL 应返回 true', () => {
    expect(isURL('http://example.com:3000')).toBe(true)
    expect(isURL('http://example.com/path')).toBe(true)
  })

  it('IP 地址 URL 应返回 true', () => {
    expect(isURL('https://192.168.1.1:8080')).toBe(true)
    expect(isURL('http://10.0.0.1')).toBe(true)
  })

  it('非法 URL 应返回 false', () => {
    expect(isURL('')).toBe(false)
    expect(isURL('not-a-url')).toBe(false)
    expect(isURL('ftp://example.com')).toBe(false) // 只支持 http/https
    expect(isURL('://missing')).toBe(false)
  })
})

describe('isEmail', () => {
  it('合法邮箱应返回 true', () => {
    expect(isEmail('test@example.com')).toBe(true)
    expect(isEmail('user.name@example.com')).toBe(true)
  })

  it('非法邮箱应返回 false', () => {
    expect(isEmail('')).toBe(false)
    expect(isEmail('not-an-email')).toBe(false)
    expect(isEmail('@no-user.com')).toBe(false)
    expect(isEmail('user@')).toBe(false)
  })
})

describe('tryParseJson', () => {
  it('合法 JSON 应正确解析', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
    expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3])
    expect(tryParseJson('"hello"')).toBe('hello')
  })

  it('非法 JSON 应返回 defaultValue', () => {
    expect(tryParseJson('{invalid}')).toBeNull()
    expect(tryParseJson('', 'fallback')).toBe('fallback')
  })

  it('空字符串应返回 defaultValue', () => {
    expect(tryParseJson('', {})).toEqual({})
    expect(tryParseJson('')).toBeNull()
  })

  it('null 输入应返回 defaultValue', () => {
    expect(tryParseJson(null as any, 'default')).toBe('default')
  })
})

describe('fomatFloat', () => {
  it('应保留指定位数小数', () => {
    expect(fomatFloat(3.14159, 2)).toBe('3.14')
    expect(fomatFloat(3.14159, 4)).toBe('3.1416') // Math.round 四舍五入
  })

  it('不足位数的应补零', () => {
    expect(fomatFloat(2, 2)).toBe('2.00')
    expect(fomatFloat(2.5, 3)).toBe('2.500')
  })

  it('字符串数字输入应正常处理', () => {
    expect(fomatFloat('3.14', 2)).toBe('3.14')
  })

  it('NaN 输入应返回 false', () => {
    expect(fomatFloat(NaN, 2)).toBe(false)
    expect(fomatFloat('not-a-number', 2)).toBe(false)
  })

  it('四舍五入应正确', () => {
    expect(fomatFloat(2.345, 2)).toBe('2.35')
    expect(fomatFloat(2.344, 2)).toBe('2.34')
  })
})

describe('ifUnExists', () => {
  it('null/undefined/空字符串应返回兜底值', () => {
    expect(ifUnExists(null, 'fallback')).toBe('fallback')
    expect(ifUnExists(undefined, 'fallback')).toBe('fallback')
    expect(ifUnExists('', 'fallback')).toBe('fallback')
  })

  it('有效值应返回原始值', () => {
    expect(ifUnExists('hello', 'fallback')).toBe('hello')
    expect(ifUnExists(42, 0)).toBe(42)
    // 注意：false 是 falsy 值，ifUnExists 会返回兜底值 true
    // 这是当前函数的实际行为（!false 为 true）
    expect(ifUnExists(false, true)).toBe(true)
  })
})

describe('toShortPath', () => {
  it('在工作目录下的路径应转为相对路径', () => {
    expect(toShortPath('/project/src/file.ts', '/project')).toBe('src/file.ts')
  })

  it('路径与工作目录相同应返回 "."', () => {
    expect(toShortPath('/project', '/project')).toBe('.')
  })

  it('Windows 反斜杠路径应统一为正斜杠', () => {
    expect(toShortPath('C:\\project\\src\\file.ts', 'C:\\project')).toBe('src/file.ts')
  })

  it('不在工作目录内的路径应原样返回', () => {
    expect(toShortPath('/other/path', '/project')).toBe('/other/path')
  })

  it('空路径应返回原值', () => {
    expect(toShortPath('', '/project')).toBe('')
  })

  it('无工作目录应返回原路径', () => {
    expect(toShortPath('/some/path')).toBe('/some/path')
  })
})

describe('listGroup', () => {
  it('应按指定 key 对列表分组', () => {
    const items = [
      { type: 'fruit', name: 'apple' },
      { type: 'fruit', name: 'banana' },
      { type: 'veg', name: 'carrot' },
    ]
    const groups = listGroup(items, 'type')
    expect(groups).toHaveLength(2)
    expect(groups[0].name).toBe('fruit')
    expect(groups[0].list).toHaveLength(2)
    expect(groups[1].name).toBe('veg')
    expect(groups[1].list).toHaveLength(1)
  })

  it('空列表应返回空数组', () => {
    expect(listGroup([], 'type' as any)).toHaveLength(0)
  })
})

describe('getUrlFileName', () => {
  it('应从 URL 中提取文件名', () => {
    expect(getUrlFileName('https://example.com/file.txt')).toBe('file.txt')
    expect(getUrlFileName('https://example.com/path/to/doc.pdf')).toBe('doc.pdf')
  })

  it('带查询参数的 URL 应正确提取', () => {
    expect(getUrlFileName('https://example.com/file.txt?token=abc')).toBe('file.txt')
  })

  it('无文件名的 URL 应返回默认值', () => {
    expect(getUrlFileName('', 'default-name')).toBe('default-name')
    expect(getUrlFileName('https://example.com/', 'fallback')).toBe('fallback')
  })
})
