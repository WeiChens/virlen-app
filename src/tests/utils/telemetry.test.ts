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
  buildBundleDoc,
  BUNDLE_DOC_NAME,
} from '@/utils/telemetry'
import type { TelemetryEvent } from '@/utils/telemetry'
import type { TelemetryBundle } from '@/utils/telemetry/transport'

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

// ==================== 导出文档（SCHEMA.md） ====================

const COMMON = {
  app_version: '0.1.2',
  platform: 'windows',
  os_version: '10.0.19045',
  arch: 'x86_64',
  locale: 'zh-CN',
  theme: 'dark',
  font_size: 'medium',
  engine: 'ts' as const,
  window_w: 1280,
  window_h: 800,
  dpr: 1,
  is_dev: false,
}

function mkEvent(
  event_name: string,
  props: Record<string, any> = {},
  over: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return {
    event_name,
    event_id: 'e-' + Math.random().toString(36).slice(2),
    event_time: 1730000000000,
    device_id: 'd-x',
    app_run_id: 'r-x',
    seq: 1,
    sdk_version: '1.0.0',
    common: COMMON,
    props,
    ...over,
  }
}

function mkBundle(events: TelemetryEvent[]): TelemetryBundle {
  return {
    device_id: 'd-x',
    app_run_id: 'r-x',
    app_version: '0.1.2',
    platform: 'windows',
    sdk_version: '1.0.0',
    exported_at: 1730000001000,
    event_count: events.length,
    events,
  }
}

describe('telemetry/buildBundleDoc — 导出文档', () => {
  it('文件名固定为 SCHEMA.md', () => {
    expect(BUNDLE_DOC_NAME).toBe('SCHEMA.md')
  })

  it('空事件时给出明确提示，不抛错', () => {
    const doc = buildBundleDoc(mkBundle([]))
    expect(doc).toContain('# Virlen 埋点导出包')
    expect(doc).toContain('共 **0** 条事件')
    expect(doc).toContain('本包没有事件')
  })

  it('汇总计数 / 事件分布 / 各事件字段', () => {
    const bundle = mkBundle([
      mkEvent(
        'tool.call.end',
        { tool_name: 'execute_command', status: 'fail', duration_ms: 12 },
        { trace_id: 't-1', event_time: 1730000000000 },
      ),
      mkEvent(
        'tool.call.end',
        { tool_name: 'search', status: 'success', duration_ms: 3 },
        { trace_id: 't-1', event_time: 1730000000050 },
      ),
      mkEvent(
        'error.api',
        { http_status: 429, error: 'rate limited' },
        { trace_id: 't-2', event_time: 1730000000100 },
      ),
    ])
    const doc = buildBundleDoc(bundle)

    // 总览
    expect(doc).toContain('共 **3** 条事件')
    expect(doc).toContain('覆盖 **2** 种事件名')
    expect(doc).toContain('错误事件 **1** 条')
    expect(doc).toContain('失败(status=fail) **1** 条')
    // 分布表
    expect(doc).toContain('`tool.call.end`')
    expect(doc).toContain('`error.api`')
    // 字段明细（含条数与覆盖率）
    expect(doc).toContain('### `tool.call.end`  （2 条）')
    expect(doc).toContain('`tool_name`')
    expect(doc).toContain('2/2（100%）')
    // trace 归组
    expect(doc).toContain('`t-1`')
    expect(doc).toContain('| `t-1` | 2 |')
  })

  it('推断 props 类型（int/float/bool/str/arr/obj）', () => {
    const doc = buildBundleDoc(
      mkBundle([
        mkEvent('settings.change', {
          key: 'theme',
          flag: true,
          n: 3,
          f: 1.5,
          list: [1, 2],
          obj: { a: 1 },
        }),
      ]),
    )
    expect(doc).toContain('`flag` | bool')
    expect(doc).toContain('`n` | int')
    expect(doc).toContain('`f` | float')
    expect(doc).toContain('`list` | arr')
    expect(doc).toContain('`obj` | obj')
    expect(doc).toContain('`key` | str')
  })

  it('统计打码 / 截断标记事件（§9 预期行为）', () => {
    const doc = buildBundleDoc(
      mkBundle([
        mkEvent('tool.call.end', { apiKey: '***' }),
        mkEvent('tool.call.end', { output: 'x…[truncated 5 chars]' }),
        mkEvent('tool.call.end', { note: 'a[REDACTED]b' }),
      ]),
    )
    expect(doc).toContain('redacted_events')
    expect(doc).toContain('truncated_events')
    // redacted: 第 1、3 条；truncated: 第 2 条
    expect(doc).toMatch(/redacted_events \| 2 \|/)
    expect(doc).toMatch(/truncated_events \| 1 \|/)
  })

  it('含 jq 读取示例与脱敏说明', () => {
    const doc = buildBundleDoc(mkBundle([mkEvent('app.start', {})]))
    expect(doc).toContain('建议的读取方式')
    expect(doc).toContain('jq')
    expect(doc).toContain('[REDACTED]')
  })
})
