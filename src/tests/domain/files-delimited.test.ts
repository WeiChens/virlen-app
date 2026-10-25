// @vitest-environment node
/**
 * CSV / TSV 草稿 → 表格网格（面板预览用）。
 *
 * 钉住三件事（与 Rust `doc_parse::delimited` 同一口径，否则同一份文件在正文与预览里列数不同）：
 * - 分隔符嗅探：首行里出现最多的那个；次数打平取 `,` `;` `\t` `|` 里靠前的；
 * - 引号：只在格子开头生效，`""` 是一个字面引号，引号内的分隔符 / 换行都属于同一格；
 * - 上限：只限制物化，`rowCount` / `colCount` 仍是真实总量。
 */
import { describe, expect, it } from 'vitest'
import { MAX_PREVIEW_COLS, MAX_PREVIEW_ROWS, parseDelimitedGrid, sniffDelimiter } from '@/domain/files/delimited'

describe('分隔符嗅探', () => {
  it('取首行里出现最多的那个', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';')
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t')
    expect(sniffDelimiter('a|b|c\n1|2|3\n')).toBe('|')
  })

  it('首行是空的（文件以空行开头）时看第一条非空行', () => {
    expect(sniffDelimiter('\n\na;b\n1;2\n')).toBe(';')
  })

  it('次数打平时按 `,` `;` 制表符 `|` 的顺序取先者', () => {
    expect(sniffDelimiter('a,b;c\n')).toBe(',')
    expect(sniffDelimiter('a;b|c\n')).toBe(';')
  })

  it('一个候选都没有时回退逗号', () => {
    expect(sniffDelimiter('单列\n第二行\n')).toBe(',')
    expect(sniffDelimiter('')).toBe(',')
  })
})

describe('切成网格', () => {
  it('普通 CSV：一行一条记录、一格一个值', () => {
    const grid = parseDelimitedGrid('a,b\n1,2\n')
    expect(grid.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(grid.rowCount).toBe(2)
    expect(grid.colCount).toBe(2)
  })

  it('末尾换行不多出一行空行；没有末尾换行的最后一行也要收下', () => {
    expect(parseDelimitedGrid('a,b\n').rows).toEqual([['a', 'b']])
    expect(parseDelimitedGrid('a,b').rows).toEqual([['a', 'b']])
  })

  it('引号里的逗号与换行属于同一格，`""` 是一个字面引号', () => {
    const grid = parseDelimitedGrid('a,"x,y",c\n"line1\nline2","he said ""hi""",z\n')
    expect(grid.rows).toEqual([
      ['a', 'x,y', 'c'],
      ['line1\nline2', 'he said "hi"', 'z'],
    ])
    expect(grid.rowCount).toBe(2)
  })

  it('引号只认格子开头（`a"b` 里的引号就是普通字符）', () => {
    expect(parseDelimitedGrid('a"b,c\n').rows).toEqual([['a"b', 'c']])
  })

  it('CRLF 不把 `\\r` 留在格子里', () => {
    expect(parseDelimitedGrid('a,b\r\n1,2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('tsv 恒用制表符，不嗅探（内容里的逗号不算分隔符）', () => {
    expect(parseDelimitedGrid('a,b\tc\n', 'tsv').rows).toEqual([['a,b', 'c']])
  })

  it('每行列数不齐是常态：不补齐、不报错', () => {
    const grid = parseDelimitedGrid('a,b,c\n1\n')
    expect(grid.rows).toEqual([['a', 'b', 'c'], ['1']])
    expect(grid.colCount).toBe(3)
  })
})

describe('上限', () => {
  it('物化的行数受上限约束，真实行数照旧报', () => {
    const text = Array.from({ length: MAX_PREVIEW_ROWS + 20 }, (_, i) => `r${i},x`).join('\n')
    const grid = parseDelimitedGrid(text)
    expect(grid.rows.length).toBe(MAX_PREVIEW_ROWS)
    expect(grid.rowCount).toBe(MAX_PREVIEW_ROWS + 20)
  })

  it('物化的列数受上限约束，真实列数照旧报', () => {
    const text = Array.from({ length: MAX_PREVIEW_COLS + 5 }, (_, i) => `c${i}`).join(',')
    const grid = parseDelimitedGrid(text)
    expect(grid.rows[0].length).toBe(MAX_PREVIEW_COLS)
    expect(grid.colCount).toBe(MAX_PREVIEW_COLS + 5)
  })
})
