/**
 * 处理终端输出中的 \r（回车覆盖）和光标移动转义序列，
 * 返回处理后的纯文本（不包含颜色/样式 ANSI 码）。
 *
 * 用行缓冲区模拟虚拟终端：
 * - \r        → 回到当前行首，后续字符覆盖
 * - \n        → 换行（光标移到下一行行首）
 * - \x1b[nA   → 光标上移 n 行
 * - \x1b[nB   → 光标下移 n 行
 * - \x1b[nC   → 光标右移 n 列
 * - \x1b[nD   → 光标左移 n 列
 * - \x1b[K    → 清除从光标到行尾
 * - \x1b[2J   → 清屏
 * - 其他 \x1b[... 序列（如颜色码）→ 忽略
 * - \x1b[?25l / \x1b[?25h → 忽略
 */
export function processTerminalOutput(raw: string): string {
  if (!raw) return ''

  // 行缓冲区
  const buffer: string[] = ['']
  let row = 0 // 当前行（从 0 开始）
  let col = 0 // 当前列

  let i = 0
  while (i < raw.length) {
    const ch = raw[i]

    if (ch === '\r') {
      // 回车：回到行首
      col = 0
      i++
    } else if (ch === '\n') {
      // 换行：移动到下一行
      row++
      col = 0
      if (row >= buffer.length) {
        buffer.push('')
      }
      i++
    } else if (ch === '\x1b' && raw[i + 1] === '[') {
      // ANSI CSI 序列: ESC [
      let j = i + 2

      // 提取数字参数（可能有多个，如 \x1b[2;3H）
      let numStr = ''
      while (j < raw.length && '0123456789;'.includes(raw[j])) {
        numStr += raw[j]
        j++
      }

      const cmd = raw[j]
      const num = parseInt(numStr, 10) || 1
      i = j + 1 // 跳过命令字符

      switch (cmd) {
        case 'A': // 光标上移
          row = Math.max(0, row - num)
          break
        case 'B': // 光标下移
          row = Math.min(buffer.length - 1, row + num)
          break
        case 'C': // 光标右移
          col += num
          break
        case 'D': // 光标左移
          col = Math.max(0, col - num)
          break
        case 'K': {
          // 清除从光标到行尾
          const line = buffer[row] ?? ''
          buffer[row] = line.substring(0, col)
          break
        }
        case 'J': {
          // 清除屏幕
          // 0 = 光标到屏幕尾, 1 = 屏幕头到光标, 2/3 = 全屏
          const mode = numStr ? parseInt(numStr, 10) : 0
          if (mode === 2 || mode === 3) {
            buffer.length = 0
            buffer.push('')
            row = 0
            col = 0
          }
          break
        }
        case 'H': {
          // 光标定位: \x1b[row;colH
          const parts = numStr.split(';')
          const r = parseInt(parts[0], 10) || 1
          const c = parseInt(parts[1], 10) || 1
          row = r - 1
          col = c - 1
          break
        }
        default:
          // 忽略其他 ANSI 码（颜色、样式、光标隐藏等）
          break
      }
    } else if (ch === '\t') {
      // Tab → 补到下一个 8 列边界
      const tabStop = 8
      const nextCol = Math.ceil((col + 1) / tabStop) * tabStop
      while (row >= buffer.length) buffer.push('')
      let line = buffer[row]
      while (col < nextCol) {
        if (col >= line.length) {
          line += ' '
        }
        col++
      }
      buffer[row] = line
      i++
    } else if (ch >= ' ') {
      // 可打印字符：写入缓冲区
      while (row >= buffer.length) {
        buffer.push('')
      }
      let line = buffer[row]
      if (col >= line.length) {
        // 追加到行尾
        buffer[row] = line + ch
      } else {
        // 覆盖当前位置
        buffer[row] = line.substring(0, col) + ch + line.substring(col + 1)
      }
      col++
      i++
    } else {
      // 不可见控制字符（如 \x00-\x1f 中未处理的）→ 跳过
      i++
    }
  }

  // 移除尾部空行（保留至少一行）
  while (buffer.length > 1 && buffer[buffer.length - 1] === '') {
    buffer.pop()
  }
  return buffer.join('\n')
}
