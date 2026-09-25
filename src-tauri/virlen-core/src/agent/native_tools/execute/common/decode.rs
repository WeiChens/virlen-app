//! 终端输出解码与有界缓冲（execute 分类内部使用）。
//!
//! - `decode_output`：UTF-8 优先；失败时按 Windows ANSI 代码页（GBK/CP936）兜底。
//! - `TerminalDecoder`：跨 8KB 分块流式解码，保留跨块的多字节序列尾部。
//! - `push_bounded` / `push_bytes_bounded`：内存有界，超限丢早期内容并插一次提示。

/// 将输出字节流解码为字符串：优先 UTF-8；失败时按 Windows ANSI 代码页兜底。
/// 中文 Windows 上 Windows PowerShell 5.1 通过管道输出时默认使用 GBK/CP936，
/// 若一律按 UTF-8 硬解会出现 `�` 乱码（如中文文件名显示为 ��������.wav）。
pub(super) fn decode_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            #[cfg(target_os = "windows")]
            {
                // encoding_rs::GBK 即 CP936，覆盖中文系统最常见场景。
                // 其他 ANSI 代码页（CP932/CP950 等）可后续按 GetACP/GetOEMCP 扩展。
                let (cow, _, _) = encoding_rs::GBK.decode(bytes);
                cow.into_owned()
            }
            #[cfg(not(target_os = "windows"))]
            {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

/// 单条流的内存上限（1 MB）与截断后保留的末尾长度（256 KB）。
///
/// 目的：让 `yes` / `cat 大文件` 这类命令打不爆内存（`docs/pty-research.md` §6.2）。
/// 「会话日志 append-only 落盘 + 内存只留有界 tail cache」的完整方案属于后续阶段，
/// 这里先做「有界 + 提示」这一步。
const STREAM_CAP: usize = 1024 * 1024;
const STREAM_KEEP: usize = 256 * 1024;
/// 发生截断时插在输出开头的提示。
const STREAM_TRUNCATED_NOTE: &str = "(output too long; earlier content was dropped)\n";

/// 有界追加**文本**：超过 `STREAM_CAP` 后丢弃最早的部分，只保留末尾 `STREAM_KEEP` 字节，
/// 并在开头插入一次截断提示。按 UTF-8 边界对齐，避免把多字节字符切成两半。
pub(super) fn push_bounded(buf: &mut String, chunk: &str) {
    buf.push_str(chunk);
    if buf.len() <= STREAM_CAP {
        return;
    }
    let mut cut = buf.len() - STREAM_KEEP;
    while cut < buf.len() && !buf.is_char_boundary(cut) {
        cut += 1;
    }
    let tail = buf[cut..].to_string();
    buf.clear();
    buf.push_str(STREAM_TRUNCATED_NOTE);
    buf.push_str(&tail);
}

/// 有界追加**原始字节**（读线程用，末尾整体解码）。返回是否发生了截断。
///
/// 这里按字节切、不保证 UTF-8 边界 —— 被切碎的字符最坏会多出一个替换字符，
/// 而被截断的输出本来就不是完整内容，可以接受。
pub(super) fn push_bytes_bounded(buf: &mut Vec<u8>, chunk: &[u8]) -> bool {
    buf.extend_from_slice(chunk);
    if buf.len() <= STREAM_CAP {
        return false;
    }
    let cut = buf.len() - STREAM_KEEP;
    buf.drain(..cut);
    true
}

/// 解码读线程的原始字节缓冲；被截断过时在开头插入提示。
pub(super) fn decode_tail(buf: &[u8], truncated: bool) -> String {
    let text = decode_output(buf);
    if truncated {
        format!("{STREAM_TRUNCATED_NOTE}{text}")
    } else {
        text
    }
}

/// 流式解码器：跨 8KB 分块保留多字节序列尾部，避免字符在块边界被切断成乱码。
/// 内部区分三态：全部合法 UTF-8 / 尾部是跨块的不完整 UTF-8 序列 / 出现非 UTF-8 字节（GBK 等）。
pub(super) struct TerminalDecoder {
    pending: Vec<u8>,
}

enum Utf8Status {
    /// 全部字节可构成合法 UTF-8
    Complete,
    /// pos 之前是合法 UTF-8，pos 开始是跨块的不完整序列（等更多字节）
    Incomplete { pos: usize },
    /// pos 处出现无法按 UTF-8 解释的字节（可能是 GBK 等编码）
    NotUtf8 { pos: usize },
}

impl TerminalDecoder {
    pub(super) fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// 追加一段原始字节，返回本次可安全解码出的文本
    pub(super) fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match self.utf8_status() {
            Utf8Status::Complete => {
                match std::str::from_utf8(&self.pending) {
                    Ok(_) => String::from_utf8(std::mem::take(&mut self.pending)).unwrap(),
                    Err(_) => {
                        // 结构看似 UTF-8 但实际非法（overlong/surrogate）→ 兜底解码
                        let text = decode_output(&self.pending);
                        self.pending.clear();
                        text
                    }
                }
            }
            Utf8Status::Incomplete { pos } => {
                if pos == 0 {
                    // 全部是跨块的不完整序列，等更多字节
                    String::new()
                } else {
                    let text = String::from_utf8(self.pending[..pos].to_vec()).unwrap();
                    self.pending.drain(..pos);
                    text
                }
            }
            Utf8Status::NotUtf8 { pos } => {
                if pos > 0 {
                    // 先输出前面合法的 UTF-8 前缀，GBK 部分留到后续整体兜底
                    let text = String::from_utf8(self.pending[..pos].to_vec()).unwrap();
                    self.pending.drain(..pos);
                    text
                } else {
                    // 整体按兜底编码解码（GBK 等），清空
                    let text = decode_output(&self.pending);
                    self.pending.clear();
                    text
                }
            }
        }
    }

    /// 流结束时解码剩余字节
    pub(super) fn finish(&mut self) -> String {
        let text = decode_output(&self.pending);
        self.pending.clear();
        text
    }

    /// 判断当前 pending 的 UTF-8 状态（从前往后扫描）
    fn utf8_status(&self) -> Utf8Status {
        let bytes = &self.pending;
        let n = bytes.len();
        let mut i = 0;
        while i < n {
            let b = bytes[i];
            if b < 0x80 {
                i += 1;
                continue;
            }
            if (0xC2..=0xF4).contains(&b) {
                let seq = if b >= 0xF0 { 4 } else if b >= 0xE0 { 3 } else { 2 };
                if i + seq > n {
                    // 序列不完整：可能跨块，也可能真不是 UTF-8，先保守等待
                    return Utf8Status::Incomplete { pos: i };
                }
                let all_cont = (1..seq).all(|k| (0x80..=0xBF).contains(&bytes[i + k]));
                if !all_cont {
                    return Utf8Status::NotUtf8 { pos: i };
                }
                i += seq;
                continue;
            }
            // 0x80-0xBF 单独出现 / 0xC0、0xC1 等非法起始 → 不是 UTF-8
            return Utf8Status::NotUtf8 { pos: i };
        }
        Utf8Status::Complete
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 跨平台部分：UTF-8 原样透传 / ASCII / 空输入。
    #[test]
    fn test_decode_output() {
        // UTF-8 原样
        assert_eq!(decode_output("后面杂音.wav".as_bytes()), "后面杂音.wav");
        // ASCII 不变
        assert_eq!(decode_output(b"Name : 979244"), "Name : 979244");
        // 空
        assert_eq!(decode_output(b""), "");
    }

    /// GBK/CP936 兜底**只在 Windows 生效**（非 Windows 终端输出恒为 UTF-8，
    /// `decode_output` 走 `from_utf8_lossy`），故按平台门禁，避免 Linux CI 误报。
    #[test]
    #[cfg(target_os = "windows")]
    fn test_decode_output_gbk_fallback() {
        // GBK 字节（CP936）→ 正确解码（中文 Windows PowerShell 管道输出的典型情况）
        let gbk = "后面杂音.wav";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(gbk);
        assert_eq!(decode_output(&gbk_bytes), gbk);
    }

    #[test]
    fn test_terminal_decoder_utf8_split() {
        // 模拟 UTF-8 多字节字符被 8KB 分块切断（最极端：逐字节喂入），应正确还原
        let text = "a后面杂音b";
        let bytes = text.as_bytes();
        let mut d = TerminalDecoder::new();
        let mut out = String::new();
        for i in 0..bytes.len() {
            out.push_str(&d.push(&bytes[i..i + 1]));
        }
        out.push_str(&d.finish());
        assert_eq!(out, text);
    }

    /// 同上：GBK 兜底仅 Windows 生效 → 该用例按平台门禁。
    #[test]
    #[cfg(target_os = "windows")]
    fn test_terminal_decoder_gbk_chunks() {
        // GBK 输出按完整双字节块喂入（8KB 分块不会拆开字符的常见情况）
        let gbk_text = "后面杂音.wav";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(gbk_text);
        let gbk_bytes = gbk_bytes.into_owned();
        let mut d = TerminalDecoder::new();
        let mut out = String::new();
        for i in (0..gbk_bytes.len()).step_by(2) {
            let end = (i + 2).min(gbk_bytes.len());
            out.push_str(&d.push(&gbk_bytes[i..end]));
        }
        out.push_str(&d.finish());
        assert_eq!(out, gbk_text);
    }

    /// 内存有界：超过上限后丢弃早期内容并插入一次提示，尾部内容保留。
    #[test]
    fn test_push_bounded_drops_earliest() {
        let mut buf = String::new();
        push_bounded(&mut buf, &"x".repeat(STREAM_CAP + 1024));
        assert!(buf.starts_with(STREAM_TRUNCATED_NOTE));
        assert!(buf.len() <= STREAM_KEEP + STREAM_TRUNCATED_NOTE.len() + 8);
        // 再次超限：提示仍然存在（不会被一起裁掉）
        push_bounded(&mut buf, &"y".repeat(STREAM_CAP));
        assert!(buf.starts_with(STREAM_TRUNCATED_NOTE));
        assert!(buf.ends_with('y'));
    }

    /// 有界缓冲要按 UTF-8 边界裁剪，不能把中文切成半个字。
    #[test]
    fn test_push_bounded_keeps_utf8_boundary() {
        let mut buf = String::new();
        let n = STREAM_CAP / '中'.len_utf8() + 10;
        push_bounded(&mut buf, &"中".repeat(n));
        assert!(!buf.contains('\u{FFFD}'));
        assert!(buf[STREAM_TRUNCATED_NOTE.len()..]
            .chars()
            .all(|c| c == '中'));
    }

    /// 内存有界（字节版）：读线程的原始缓冲同样有上限，`yes` 不能打爆内存。
    #[test]
    fn test_push_bytes_bounded() {
        let mut buf: Vec<u8> = Vec::new();
        assert!(!push_bytes_bounded(&mut buf, b"abc"));
        assert_eq!(buf, b"abc");
        let mut big: Vec<u8> = Vec::new();
        assert!(push_bytes_bounded(&mut big, &vec![b'z'; STREAM_CAP + 1]));
        assert!(big.len() <= STREAM_KEEP);
    }
}
