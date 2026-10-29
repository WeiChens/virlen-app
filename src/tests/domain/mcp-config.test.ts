/**
 * MCP 配置的**编辑态**纯逻辑测试。
 *
 * 校验规则在 Rust（`mcp::config::validate`）与本文件测的 TS 实现各有一份 ——
 * 这里固定的正是「两侧必须同语义」的那几条（服务器名、超时、传输字段、重名）。
 */
import {
  MAX_SERVER_NAME_LEN,
  MAX_TOOL_NAME_LEN,
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
  validateMcpToolAlias,
  validateServerName,
  withToolAlias,
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

  it('新建草稿默认「直接执行」（与 Rust 的 McpApproval 缺省同口径）', () => {
    expect(createMcpServerDraft('stdio').approval).toBe('allow')
    expect(createMcpServerDraft('http').approval).toBe('allow')
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

describe('工具公开名（别名）校验与编辑', () => {
  it('合法名字与边界（与 Rust validate_tool_alias 同语义）', () => {
    for (const name of ['look', 'blender_look', 'a-b_C9', 'x'.repeat(MAX_TOOL_NAME_LEN)]) {
      expect(validateMcpToolAlias(name), name).toBeNull()
    }
    expect(validateMcpToolAlias('')).toContain('不能为空')
    expect(validateMcpToolAlias('has space')).toContain('只能包含')
    expect(validateMcpToolAlias('读取')).toContain('只能包含')
    expect(validateMcpToolAlias('x'.repeat(MAX_TOOL_NAME_LEN + 1))).toContain('不能超过')
    // 历史前缀会被旧数据当成 `mcp__<server>__<raw>` 解析
    expect(validateMcpToolAlias('mcp__blender__look')).toContain('不能以')
  })

  it('别名表：写入 / 改回原名 / 清空即删除，全空时整个键不写', () => {
    const one = withToolAlias(undefined, 'look', 'blender_look')
    expect(one).toEqual({ look: 'blender_look' })

    const two = withToolAlias(one, 'stat', 'blender_stat')
    expect(two).toEqual({ look: 'blender_look', stat: 'blender_stat' })

    // 改回原名 = 恢复默认（删条目）
    expect(withToolAlias(two, 'look', ' look ')).toEqual({ stat: 'blender_stat' })
    expect(withToolAlias(two, 'look', '')).toEqual({ stat: 'blender_stat' })
    // 最后一条也删掉 → `undefined`（不往配置里写空对象）
    expect(withToolAlias({ look: 'blender_look' }, 'look', '')).toBeUndefined()
  })

  it('配置校验会拦住自相矛盾的别名（与内置重名不在这里拦）', () => {
    const base = createMcpServerDraft('stdio')
    base.name = 'blender'
    base.command = 'npx'

    base.toolAliases = { look: 'has space' }
    expect(validateMcpConfig(base)).toContain('只能包含')

    base.toolAliases = { look: 'same', stat: 'same' }
    expect(validateMcpConfig(base)).toContain('重复')

    // 占用内置工具名只会在发布期被内置工具顶掉（界面横幅报），不阻塞保存
    base.toolAliases = { look: 'read_file' }
    expect(validateMcpConfig(base)).toBeNull()
  })
})

describe('文本框 ↔ 结构互转', () => {  it('参数每行一个，空行忽略', () => {
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
