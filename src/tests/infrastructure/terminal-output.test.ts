// @vitest-environment node
/**
 * 终端输出处理（processTerminalOutput）—— 与 Rust 侧 `process_terminal_output` 逐条对齐。
 *
 * 为什么要有这组用例：执行路径改成 PTY（ConPTY）后，输出里会出现大量
 * 光标 / 擦除 / OSC 序列（`\x1b[87X`、`\x1b]0;…\x07`、`\x1b[?25l`）。
 * 旧解析器只认 `ESC [` 且只吃 0-9;，会把 `\x1b[?25l` 的 "25l" 漏成正文。
 * Rust 侧对应的用例在 `src-tauri/virlen-core/src/agent/native_tools/execute/common.rs`
 * （`test_process_terminal_output_ansi_sequences`），两边必须保持一致（铁律 1）。
 */
import { describe, it, expect } from 'vitest'
import {
  processTerminalOutput,
  TerminalOutputParser,
} from '@/infrastructure/tools/execute/common'

describe('processTerminalOutput 基础行为（回归）', () => {
  it('纯文本原样返回', () => {
    expect(processTerminalOutput('hello')).toBe('hello')
  })

  it('\\r 覆盖（进度条）', () => {
    expect(processTerminalOutput('10%\r50%\r100%')).toBe('100%')
  })

  it('ANSI 颜色被剥离', () => {
    expect(processTerminalOutput('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('CRLF 归一化', () => {
    expect(processTerminalOutput('a\r\nb')).toBe('a\nb')
  })
})

describe('processTerminalOutput 转义序列必须完整吞掉', () => {
  it('私有模式（DECSET/DECRST）不留残渣', () => {
    expect(processTerminalOutput('\x1b[?25lhi\x1b[?25h')).toBe('hi')
    expect(processTerminalOutput('\x1b[?25labc')).toBe('abc')
  })

  it('ECH 擦除字符不产生正文', () => {
    expect(processTerminalOutput('ab\x1b[10Xcd')).toBe('abcd')
  })

  it('OSC（改窗口标题）整条忽略', () => {
    expect(processTerminalOutput('\x1b]0;title\x07ok')).toBe('ok')
    expect(processTerminalOutput('\x1b]0;title\x1b\\ok')).toBe('ok')
  })

  it('带中间字节的 CSI', () => {
    expect(processTerminalOutput('\x1b[1 qx')).toBe('x')
  })

  it('三字节转义（ESC ( 0 切字符集）与两字符转义', () => {
    expect(processTerminalOutput('\x1b7A\x1b(0B')).toBe('AB')
  })

  it('光标定位 + 擦行', () => {
    expect(processTerminalOutput('\x1b[1;1H\x1b[Kab')).toBe('ab')
  })

  it('退格移动光标', () => {
    expect(processTerminalOutput('ab\x08c')).toBe('ac')
  })

  it('颜色 + 私有模式混排（真实 PTY 流的典型形状）', () => {
    expect(processTerminalOutput('\x1b[?25l\x1b[32mOK\x1b[0m\x1b[?25h')).toBe(
      'OK',
    )
  })
})

/**
 * 增量解析（`TerminalOutputParser`）：运行中每 50ms 只解析新增部分。
 *
 * 三条不可退让的约束：
 * 1. **结果必须与一次性解析逐字一致** —— 否则运行中与结束后的文本会不一样；
 * 2. **半截转义序列要留到下一块** —— chunk 边界正好切在 `\x1b[` 中间是常态；
 * 3. **重复喂同一份是幂等的** —— React StrictMode / 重复渲染会把同一 length 喂两次。
 */
describe('TerminalOutputParser（增量解析）', () => {
  it('任意切分方式的结果都等于一次性解析', () => {
    const full =
      '\x1b[?25lstart\r\x1b[32mworking\x1b[0m\r\x1b[Kdone\n' +
      '\x1b]0;title\x07' +
      'a\tb\x08c\n'
    const expected = processTerminalOutput(full)
    for (let size = 1; size <= 5; size++) {
      const parser = new TerminalOutputParser()
      let out = ''
      for (let i = size; i <= full.length; i += size) {
        out = parser.feed(full.slice(0, i))
      }
      out = parser.feed(full)
      expect(out).toBe(expected)
    }
  })

  it('转义序列被切在两块之间：不当正文吐出来', () => {
    const parser = new TerminalOutputParser()
    expect(parser.feed('a\x1b')).toBe('a')
    expect(parser.feed('a\x1b[')).toBe('a')
    expect(parser.feed('a\x1b[31')).toBe('a')
    expect(parser.feed('a\x1b[31mred')).toBe('ared')
  })

  it('OSC 被切断：标题不落到正文里', () => {
    const parser = new TerminalOutputParser()
    expect(parser.feed('\x1b]0;tit')).toBe('')
    expect(parser.feed('\x1b]0;title\x07ok')).toBe('ok')
  })

  it('同一份内容重复喂（StrictMode）：不重复追加', () => {
    const parser = new TerminalOutputParser()
    expect(parser.feed('ab')).toBe('ab')
    expect(parser.feed('ab')).toBe('ab')
    expect(parser.feed('abcd')).toBe('abcd')
  })

  it('输出变短（换了一条流）：重置后再解析', () => {
    const parser = new TerminalOutputParser()
    expect(parser.feed('first\nline')).toBe('first\nline')
    expect(parser.feed('second')).toBe('second')
  })

  it('尾部空行只在输出时裁掉，不影响后续光标定位', () => {
    // 全量解析：`a\n\n` → `a`；随后 `\x1b[B` 下移一行再写 x，应落在**第三行**
    const whole = processTerminalOutput('a\n\n\x1b[Bx')
    const parser = new TerminalOutputParser()
    expect(parser.feed('a\n\n')).toBe('a')
    expect(parser.feed('a\n\n\x1b[Bx')).toBe(whole)
    expect(whole).toBe('a\n\nx')
  })
})
