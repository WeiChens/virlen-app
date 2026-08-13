/**
 * execute-command 命令解析/风险分类测试 — 回归：引号内内容不应被展开
 *
 * 覆盖场景：
 * - 引号内的 ; / && / || 不应被当作命令分隔符，从而不会把引号内内容误判为命令名
 * - 引号外的分隔符仍然生效（风险分类不受影响）
 * - 带空格的引号命令名可正确提取（如 "C:\Program Files\app.exe"）
 */
import { describe, it, expect } from 'vitest'
import {
  classifyCommand,
  extractCommandName,
  extractAllCommandNames,
} from '@/infrastructure/tools/builtin/execute-command'

describe('extractAllCommandNames 引号感知分割', () => {
  it('引号内的 ; 不应被切开', () => {
    expect(extractAllCommandNames('echo "a;b"')).toEqual(['echo'])
    expect(extractAllCommandNames("echo 'a;b'")).toEqual(['echo'])
  })

  it('引号内的 && / || 不应被切开', () => {
    expect(extractAllCommandNames('echo "a&&b"')).toEqual(['echo'])
    expect(extractAllCommandNames("echo 'a&&b'")).toEqual(['echo'])
    expect(extractAllCommandNames('echo "a||b"')).toEqual(['echo'])
  })

  it('引号外的分隔符仍然生效', () => {
    expect(extractAllCommandNames('echo safe; rm -rf /')).toEqual([
      'echo',
      'rm',
    ])
    expect(extractAllCommandNames('echo safe && npm install')).toEqual([
      'echo',
      'npm',
    ])
    expect(extractAllCommandNames('echo safe || ls')).toEqual(['echo', 'ls'])
  })

  it('双引号内支持 \\" 转义', () => {
    // 转义引号后的 ; 属于字符串内容，不切分
    expect(extractAllCommandNames('echo "a;b\\" c"')).toEqual(['echo'])
  })

  it('单引号内可包含双引号，不触发切分', () => {
    expect(extractAllCommandNames("echo 'say \"hi; there\"'")).toEqual([
      'echo',
    ])
  })

  it('双引号内包含单引号：单引号只是普通字符', () => {
    expect(extractAllCommandNames(`echo "it's a; test"`)).toEqual(['echo'])
  })

  it('单引号内包含双引号：双引号只是普通字符', () => {
    expect(extractAllCommandNames(`echo 'say "hi; there"'`)).toEqual([
      'echo',
    ])
  })

  it('两种引号在同一命令中互相嵌套', () => {
    expect(
      extractAllCommandNames(`echo "a'b'c" && echo 'x"y"z'`),
    ).toEqual(['echo'])
  })

  it('双引号内转义引号后，分隔符仍在引号内', () => {
    // `\"` 是转义的引号，`;` 仍在引号内 → 不切分
    expect(extractAllCommandNames(`echo "a\\"b;c"`)).toEqual(['echo'])
  })

  it('转义反斜杠后引号真正闭合，外部 rm 仍应被识别', () => {
    // `"a\\"` 里 \\ 是转义反斜杠，随后的 " 才是闭合引号，`;` 在引号外
    expect(extractAllCommandNames(`echo "a\\\\"; rm -rf /`)).toEqual([
      'echo',
      'rm',
    ])
  })
})

describe('extractCommandName 引号感知提取', () => {
  it('带空格的引号命令名可正确提取', () => {
    expect(
      extractCommandName('"C:/Program Files/app.exe" --flag'),
    ).toBe('app')
    expect(extractCommandName("'my app' --help")).toBe('my app')
  })

  it('常规命令提取不变', () => {
    expect(extractCommandName('git status')).toBe('git')
    expect(extractCommandName("'npm' install")).toBe('npm')
    expect(extractCommandName('./run.sh')).toBe('run')
  })
})

describe('classifyCommand 引号内危险命令不应误报', () => {
  it('引号内的 rm / 分隔符不触发高危', () => {
    expect(classifyCommand('echo "rm -rf /"')).toBe('safe')
    expect(classifyCommand('echo "a;b"')).toBe('safe')
    expect(classifyCommand('echo "a&&b"')).toBe('safe')
    expect(classifyCommand("echo 'sudo rm -rf /'")).toBe('safe')
    expect(classifyCommand('git commit -m "fix; bug"')).toBe('safe')
  })

  it('引号互相嵌套时危险命令不误报', () => {
    expect(classifyCommand(`echo "it's a; test"`)).toBe('safe')
    expect(classifyCommand(`echo 'say "hi; there"'`)).toBe('safe')
    expect(classifyCommand(`echo "a'b'c" && echo 'x"y"z'`)).toBe('safe')
    expect(classifyCommand(`echo "a\\"b;c"`)).toBe('safe')
    // 单引号内反斜杠不转义：`'a\'` 在 \ 后的 ' 处闭合，; 是真正的分隔符
    // （两个子命令都是 echo，仍判 safe）
    expect(classifyCommand(`echo 'a\\'; echo hi`)).toBe('safe')
    expect(extractAllCommandNames(`echo 'a\\'; echo hi`)).toEqual(['echo'])
  })

  it('转义反斜杠后引号闭合，外部危险命令仍触发高危', () => {
    // `"a\\"` 后引号真正闭合，`; rm` 在引号外 → 应识别
    expect(classifyCommand(`echo "a\\\\"; rm -rf /`)).toBe('dangerous')
  })

  it('引号外的危险命令仍然触发高危', () => {
    expect(classifyCommand('echo safe; rm -rf /')).toBe('dangerous')
    expect(classifyCommand('echo safe && rm -rf /')).toBe('dangerous')
    expect(classifyCommand('echo safe || sudo ls')).toBe('dangerous')
  })

  it('常规分类不受影响', () => {
    expect(classifyCommand('git status')).toBe('safe')
    expect(classifyCommand('node --version')).toBe('safe')
    expect(classifyCommand('npm install')).toBe('install')
    expect(classifyCommand('cmd /c "npm install"')).toBe('install')
    expect(classifyCommand('rm -rf /tmp/x')).toBe('dangerous')
  })
})
