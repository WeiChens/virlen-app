/**
 * telemetry SDK 测试 — 打码 / 文本 / 哈希 / 链路字段解析 / 错误抽取
 *
 * 覆盖：
 * - isSensitiveKey 的 `token$` 边界（first_token_ms / tokens 不应误打码）
 * - redactString 密钥模式 + 系统用户名路径脱敏
 * - redactDeep 递归打码（敏感键 → ***，字符串值走密钥模式）
 * - truncateText / urlHost / hashText 行为
 * - resolveLinkage（trace_id/span_id 顶层「上提」，opts 优先）—— DESIGN §4 回归保护
 * - toErrorInfo 抽取与打码
 */
import { describe, it, expect } from 'vitest'
import {
  redactString,
  redactDeep,
  isSensitiveKey,
  redactPath,
  truncateText,
  hashText,
  urlHost,
  REDACTED,
  resolveLinkage,
  toErrorInfo,
} from '@/utils/telemetry'

describe('telemetry/redact — isSensitiveKey', () => {
  it('度量类键（以 token 结尾才敏感）不应误判', () => {
    for (const k of [
      'first_token_ms',
      'tokens',
      'max_tokens',
      'token_count',
      'input',
      'result',
      'text_len',
      'session_id',
    ]) {
      expect(isSensitiveKey(k), k).toBe(false)
    }
  })

  it('鉴权/密钥类键应命中', () => {
    for (const k of [
      'token',
      'access_token',
      'refresh_token',
      'refreshToken',
      'id_token',
      'sessionToken',
      'apiKey',
      'api_key',
      'authorization',
      'secret',
      'password',
      'private_key',
      'credential',
    ]) {
      expect(isSensitiveKey(k), k).toBe(true)
    }
  })
})

describe('telemetry/redact — redactString', () => {
  it('打码 OpenAI / Bearer / 通用字段模式', () => {
    expect(redactString('key=sk-abcdefghij1234567890XYZ')).toContain(REDACTED)
    expect(
      redactString('Authorization: Bearer abcdefghijklmnopqrstuvwx'),
    ).toContain(REDACTED)
    expect(redactString('api_key: supersecretvalue')).toContain(REDACTED)
  })

  it('系统用户名路径前缀替换为 ~', () => {
    expect(redactString('C:\\Users\\alice\\proj\\a.txt')).toBe(
      '~\\proj\\a.txt',
    )
    expect(redactString('/home/bob/work/x')).toBe('~/work/x')
    expect(redactString('/Users/carol/a')).toBe('~/a')
  })
})

describe('telemetry/redactPath', () => {
  it('Windows/Unix 路径前缀替换为 ~', () => {
    expect(redactPath('D:\\Users\\x\\a')).toBe('~\\a')
    expect(redactPath('/Users/x/a')).toBe('~/a')
    expect(redactPath('')).toBe('')
  })
})

describe('telemetry/redactDeep', () => {
  it('递归打码敏感键与字符串值', () => {
    const out = redactDeep({
      apiKey: 'secret-value',
      nested: { password: 'p', note: 'token=sk-abcdefghij1234567890XYZ' },
      list: [{ apikey: 'k' }, 'C:\\Users\\dave\\z'],
    }) as any

    expect(out.apiKey).toBe('***')
    expect(out.nested.password).toBe('***')
    expect(out.list[0].apikey).toBe('***')
    expect(out.nested.note).toContain(REDACTED)
    expect(out.list[1]).toBe('~\\z')
  })
})

describe('telemetry/text — truncateText', () => {
  it('未超限原样返回，超限截断并附标记', () => {
    expect(truncateText('abc', 10)).toBe('abc')
    const out = truncateText('x'.repeat(20), 10)
    expect(out.startsWith('x'.repeat(10))).toBe(true)
    expect(out).toContain('truncated 10 chars')
  })
})

describe('telemetry/text — urlHost', () => {
  it('仅取域名（去 path/query），无协议可解析', () => {
    expect(urlHost('https://api.openai.com/v1/chat?x=1')).toBe('api.openai.com')
    expect(urlHost('api.anthropic.com/v1')).toBe('api.anthropic.com')
    expect(urlHost('')).toBe('')
  })
})

describe('telemetry/hashText', () => {
  it('稳定、16 位十六进制、区分不同输入', () => {
    const a = hashText('session-1')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(hashText('session-1')).toBe(a)
    expect(hashText('session-2')).not.toBe(a)
    expect(hashText('')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('telemetry/resolveLinkage — trace_id/span_id 顶层上提（§4）', () => {
  it('props 中的 trace_id/span_id 上提到顶层', () => {
    expect(resolveLinkage({ trace_id: 't-props', span_id: 's-1' })).toEqual({
      traceId: 't-props',
      spanId: 's-1',
    })
  })

  it('opts 优先于 props', () => {
    expect(
      resolveLinkage({ trace_id: 't-props' }, { traceId: 't-opts' }),
    ).toEqual({ traceId: 't-opts', spanId: undefined })
  })

  it('非字符串 / 缺失一律返回 undefined', () => {
    expect(resolveLinkage({ trace_id: 123 as any })).toEqual({
      traceId: undefined,
      spanId: undefined,
    })
    expect(resolveLinkage(undefined)).toEqual({
      traceId: undefined,
      spanId: undefined,
    })
  })
})

describe('telemetry/toErrorInfo', () => {
  it('Error → message/stack（打码）', () => {
    const e = toErrorInfo(new Error('boom sk-abcdefghij1234567890XYZ'))
    expect(e.message).toContain('boom')
    expect(e.message).toContain(REDACTED)
    expect(typeof e.stack).toBe('string')
  })

  it('字符串 / null 兜底', () => {
    expect(toErrorInfo('plain').message).toBe('plain')
    expect(toErrorInfo(null).message).toBe('unknown error')
  })
})
