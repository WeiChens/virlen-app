/**
 * MCP 配置的**编辑态**纯逻辑测试。
 *
 * 校验规则在 Rust（`mcp::config::validate`）与本文件测的 TS 实现各有一份 ——
 * 这里固定的正是「两侧必须同语义」的那几条（服务器名、超时、传输字段、重名）。
 */
import {
  MAX_SERVER_NAME_LEN,
  argsToText,
  createMcpServerDraft,
  enabledToolsToText,
  headersToText,
  pairsToText,
  stateTone,
  textToArgs,
  textToEnabledTools,
  textToHeaders,
  textToPairs,
  validateMcpConfig,
  validateMcpConfigs,
  validateServerName,
} from '@/domain/mcp'

describe('MCP 服务器名校验（与 Rust 同语义）', () => {
  it('合法名字', () => {
    for (const name of ['fs', 'my-server', 'my_server_2', 'A1']) {
      expect(validateServerName(name)).toBeNull()
    }
  })

  it('非法名字都要给出原因', () => {
    for (const name of ['', 'has space', '工具', 'a__b', 'x'.repeat(MAX_SERVER_NAME_LEN + 1)]) {
      const error = validateServerName(name)
      expect(error, name).toBeTruthy()
    }
  })

  it('__ 被指名拒绝（它是公开工具名的分隔符）', () => {
    expect(validateServerName('a__b')).toContain('__')
  })
})

describe('MCP 单条配置校验', () => {
  const base = (): ReturnType<typeof createMcpServerDraft> => {
    const draft = createMcpServerDraft('stdio')
    draft.name = 'fs'
    draft.command = 'npx'
    return draft
  }

  it('默认草稿补上必填项后可通过', () => {
    expect(validateMcpConfig(base())).toBeNull()
  })

  it('超时必须大于 0', () => {
    const config = base()
    config.toolCallTimeoutMs = 0
    expect(validateMcpConfig(config)).toContain('超时')
    const other = base()
    other.startupTimeoutMs = 0
    expect(validateMcpConfig(other)).toContain('超时')
  })

  it('stdio 必须有命令，http 必须有 http(s) URL', () => {
    const stdio = base()
    stdio.command = '   '
    expect(validateMcpConfig(stdio)).toContain('命令')

    const http = createMcpServerDraft('http')
    http.name = 'remote'
    http.url = 'ftp://x'
    expect(validateMcpConfig(http)).toContain('http')
    http.url = 'https://mcp.example.com/mcp'
    expect(validateMcpConfig(http)).toBeNull()
  })

  it('工具白名单不允许空名字', () => {
    const config = base()
    config.enabledTools = ['read_file', '  ']
    expect(validateMcpConfig(config)).toContain('空名字')
  })

  it('一批配置里名字不得重复', () => {
    const a = base()
    const b = base()
    expect(validateMcpConfigs([a, b])).toContain('重复')
    b.name = 'other'
    expect(validateMcpConfigs([a, b])).toBeNull()
  })
})

describe('文本框 ↔ 结构互转', () => {
  it('参数每行一个，空行忽略', () => {
    expect(textToArgs('-y\n\n@server\n  .  ')).toEqual(['-y', '@server', '.'])
    expect(argsToText(['-y', '@server'])).toBe('-y\n@server')
  })

  it('env 是 KEY=value，只在第一个 = 处切分，并忽略注释', () => {
    expect(textToPairs('# 注释\nFOO=bar\nTOKEN=abc=def')).toEqual({
      FOO: 'bar',
      TOKEN: 'abc=def',
    })
    expect(pairsToText({ FOO: 'bar' })).toBe('FOO=bar')
  })

  it('http 头是 Name: value', () => {
    expect(textToHeaders('Authorization: Bearer x\nX-Api-Key:abc')).toEqual({
      Authorization: 'Bearer x',
      'X-Api-Key': 'abc',
    })
    expect(headersToText({ Authorization: 'Bearer x' })).toBe('Authorization: Bearer x')
  })

  it('工具白名单空文本 = 不限制（undefined，而不是空数组）', () => {
    expect(textToEnabledTools('\n\n')).toBeUndefined()
    expect(textToEnabledTools('read_file\n')).toEqual(['read_file'])
    expect(enabledToolsToText(undefined)).toBe('')
  })
})

describe('状态配色', () => {
  it('四档色调', () => {
    expect(stateTone('ready')).toBe('ok')
    expect(stateTone('connecting')).toBe('warn')
    expect(stateTone('backoff')).toBe('warn')
    expect(stateTone('failed')).toBe('error')
    expect(stateTone('error')).toBe('error')
    expect(stateTone('disabled')).toBe('muted')
  })
})
