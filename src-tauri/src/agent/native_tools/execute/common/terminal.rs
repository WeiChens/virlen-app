//! 终端输出处理：模拟虚拟终端处理输出（`\r` 覆盖 / ANSI 转义序列），UTF-8 安全。
//!
//! 与 JS 侧 `processTerminalOutput` 对齐：ANSI / OSC / 退格 / Tab 都按 ECMA-48 解析，
//! 保证 ConPTY 输出的控制序列不会漏成正文。

/// 确保缓冲区存在第 row 行（不足则补空行）
fn ensure_row(buffer: &mut Vec<Vec<char>>, row: usize) {
    while buffer.len() <= row {
        buffer.push(Vec::new());
    }
}

/// 模拟虚拟终端处理输出（与 JS processTerminalOutput 对齐，UTF-8 安全）
pub(super) fn process_terminal_output(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut buffer: Vec<Vec<char>> = vec![Vec::new()];
    let mut row: usize = 0;
    let mut col: usize = 0;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\r' {
            col = 0;
            i += 1;
        } else if ch == '\n' {
            row += 1;
            col = 0;
            ensure_row(&mut buffer, row);
            i += 1;
        } else if ch == '\x1b' && i + 1 < chars.len() {
            // ---- ANSI 转义序列：必须**完整吞掉**，否则参数会被当成正文写进输出 ----
            // 改造前只认 `ESC [` 且只吃 0-9;，于是 `\x1b[?25l`（隐藏光标）这类私有模式的
            // 参数会被漏成正文（"25l"）。ConPTY 输出的这类序列非常密集（§6.2 / §7 #9），
            // 因此这里按 ECMA-48 完整解析：参数字节 + 中间字节 + 结束字节。
            let kind = chars[i + 1];
            if kind == '[' {
                // CSI: ESC [ 0x30-0x3F(参数) 0x20-0x2F(中间) 0x40-0x7E(结束)
                let mut j = i + 2;
                let mut params = String::new();
                while j < chars.len()
                    && matches!(chars[j], '0'..='9' | ';' | ':' | '<' | '=' | '>' | '?')
                {
                    params.push(chars[j]);
                    j += 1;
                }
                // 中间字节（空格、!、"、#、$、%、&、'、*、+、-、.、/）不属于参数，跳过
                while j < chars.len() && (' '..='/').contains(&chars[j]) {
                    j += 1;
                }
                let cmd = if j < chars.len() { chars[j] } else { ' ' };
                i = (j + 1).min(chars.len());
                // 带 ? < = > 前缀的是私有模式（DECSET/DECRST 等）→ 忽略，但必须已整体吞掉
                let private = params.starts_with(['?', '<', '=', '>']);
                let num_str = params.trim_start_matches(['?', '<', '=', '>']);
                let num: usize = num_str
                    .split(';')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                if !private {
                    match cmd {
                        'A' => row = row.saturating_sub(num),
                        'B' => row = (row + num).min(buffer.len().saturating_sub(1)),
                        'C' => col += num,
                        'D' => col = col.saturating_sub(num),
                        'K' => {
                            ensure_row(&mut buffer, row);
                            let cut = col.min(buffer[row].len());
                            buffer[row].truncate(cut);
                        }
                        'J' => {
                            let mode: usize = num_str.parse().unwrap_or(0);
                            if mode == 2 || mode == 3 {
                                buffer.clear();
                                buffer.push(Vec::new());
                                row = 0;
                                col = 0;
                            }
                        }
                        'H' | 'f' => {
                            let parts: Vec<&str> = num_str.split(';').collect();
                            let r: usize = parts
                                .first()
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(1)
                                .max(1);
                            let c: usize = parts
                                .get(1)
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(1)
                                .max(1);
                            row = r.saturating_sub(1);
                            col = c.saturating_sub(1);
                        }
                        // 'X'（擦除 n 个字符，光标不动）、'm'（颜色/样式）等对纯文本无影响
                        _ => {}
                    }
                }
            } else if kind == ']' {
                // OSC: ESC ] ... 由 BEL 或 ST(ESC \) 结束 —— 典型是改窗口标题 `\x1b]0;…\x07`
                let mut j = i + 2;
                while j < chars.len() {
                    if chars[j] == '\x07' {
                        j += 1;
                        break;
                    }
                    if chars[j] == '\x1b' && j + 1 < chars.len() && chars[j + 1] == '\\' {
                        j += 2;
                        break;
                    }
                    j += 1;
                }
                i = j.min(chars.len());
            } else if (' '..='/').contains(&kind) {
                // 带中间字节的**三字节**转义（ESC ( 0 切字符集 / ESC # 8 / ESC % G 等）
                i = (i + 3).min(chars.len());
            } else {
                // 两字符转义（ESC 7 保存光标 / ESC = 等）
                i = (i + 2).min(chars.len());
            }
        } else if ch == '\u{8}' {
            // 退格：光标左移一格（ConPTY 的擦除/重绘里会出现）
            col = col.saturating_sub(1);
            i += 1;
        } else if ch == '\t' {
            ensure_row(&mut buffer, row);
            let tab_stop = 8usize;
            let next_col = (col + tab_stop) / tab_stop * tab_stop;
            while col < next_col {
                if col >= buffer[row].len() {
                    buffer[row].push(' ');
                }
                col += 1;
            }
            i += 1;
        } else if ch >= ' ' {
            ensure_row(&mut buffer, row);
            if col >= buffer[row].len() {
                buffer[row].push(ch);
            } else {
                buffer[row][col] = ch;
            }
            col += 1;
            i += 1;
        } else {
            i += 1;
        }
    }
    while buffer.len() > 1 && buffer.last().map(|l| l.is_empty()).unwrap_or(false) {
        buffer.pop();
    }
    buffer
        .into_iter()
        .map(|l| l.into_iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_terminal_output() {
        assert_eq!(process_terminal_output("hello"), "hello");
        // \r 覆盖
        assert_eq!(process_terminal_output("progress: 10%\rprogress: 20%"), "progress: 20%");
        // ANSI 颜色剥离
        assert_eq!(process_terminal_output("\x1b[31mred\x1b[0m"), "red");
        // CRLF 归一化
        assert_eq!(process_terminal_output("a\r\nb"), "a\nb");
    }

    /// ConPTY 输出的转义序列不能漏成正文（Step 1 硬要求，§6.2 / §7 #9）。
    ///
    /// 改造前的解析器只认 `ESC [` 且只吃 0-9;，于是 `\x1b[?25l`（隐藏光标）会把 "25l"
    /// 漏成正文 —— 而伪控制台输出的这类序列非常密集。
    #[test]
    fn test_process_terminal_output_ansi_sequences() {
        // 私有模式（DECSET/DECRST）：整条吞掉，不留残渣
        assert_eq!(process_terminal_output("\x1b[?25lhi\x1b[?25h"), "hi");
        assert_eq!(process_terminal_output("\x1b[?25labc"), "abc");
        // 擦除字符（ECH，光标不动）：不产生正文
        assert_eq!(process_terminal_output("ab\x1b[10Xcd"), "abcd");
        // OSC（改窗口标题）：直到 BEL 都吞掉
        assert_eq!(process_terminal_output("\x1b]0;title\x07ok"), "ok");
        // OSC 用 ST（ESC \）结束
        assert_eq!(process_terminal_output("\x1b]0;title\x1b\\ok"), "ok");
        // 带中间字节的 CSI（`\x1b[1 q` 设置光标形状）
        assert_eq!(process_terminal_output("\x1b[1 qx"), "x");
        // 两字符转义（ESC 7 保存光标 / ESC ( 0 切字符集）
        assert_eq!(process_terminal_output("\x1b7A\x1b(0B"), "AB");
        // 光标定位 + 擦行（PowerShell 重绘提示符的常见组合）
        assert_eq!(process_terminal_output("\x1b[1;1H\x1b[Kab"), "ab");
        // 颜色 + 私有模式混排（真实 PTY 流的典型形状）
        assert_eq!(
            process_terminal_output("\x1b[?25l\x1b[32mOK\x1b[0m\x1b[?25h"),
            "OK"
        );
    }

    /// 退格键要移动光标（ConPTY 重绘里会出现）。
    #[test]
    fn test_process_terminal_output_backspace() {
        assert_eq!(process_terminal_output("ab\x08c"), "ac");
    }
}
