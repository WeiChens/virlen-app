//! 纯文本与编码 —— 「这段字节是不是文本」的判定与解码，**全仓唯一一份**。
//!
//! ⚠️ [`sniff_is_text`] / [`SNIFF_BYTES`] 原先住在 `rag::import_scan`（知识库导入的内容嗅探），
//! 现在上移到本模块：文档解析（`.txt` / `.md` / `.csv` …）与导入筛选必须**同一套判据**，
//! 否则「导入时判定是文本、解析时却读不出来」这类差异会莫名其妙。
//! `rag::import_scan` 改为 `pub use` 本模块的实现，调用点与外部路径都不变。
//!
//! 判据（与前端 `looksLikeText` 同口径，见 §5.9 文件域）：
//! 1. 空 / 含 `NUL` → 不是（图片、压缩包、可执行文件、UTF-16 都带 NUL）；
//! 2. 控制字符占比 ≥ 5% → 不是；
//! 3. UTF-8 能解（只在末尾被采样截断也算）→ 是；
//! 4. 否则用 GBK（GB18030）/ Big5 / Shift_JIS 试**干净解码** → 能解就是文本；
//! 5. 都不行 → 不是。

use encoding_rs::{BIG5, GB18030, SHIFT_JIS, UTF_16BE, UTF_16LE};

/// 嗅探「是不是纯文本」时最多读多少字节：前 8 KB 足以给一个文件定性
pub const SNIFF_BYTES: usize = 8 * 1024;

/// 采样字节看着像纯文本吗
pub fn sniff_is_text(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }
    if sample.contains(&0) {
        return false;
    }
    let bad = sample
        .iter()
        .filter(|b| **b < 0x20 && !matches!(**b, 0x09 | 0x0a | 0x0c | 0x0d))
        .count();
    if bad * 20 >= sample.len() {
        return false;
    }
    if is_valid_utf8_prefix(sample) {
        return true;
    }
    [GB18030, BIG5, SHIFT_JIS]
        .iter()
        .any(|enc| decodes_cleanly(enc, sample))
}

/// 把整份文件**解码成文本**（文档解析用的那一半：嗅探只回答「像不像」，这里要拿到内容）。
///
/// 顺序：BOM（UTF-8 / UTF-16）→ UTF-8 → GB18030 → BIG5 → Shift_JIS；都不行 → `None`（按二进制处理）。
/// ⚠️ 与 [`sniff_is_text`] 共用同一张编码表；新增编码必须两处一起加，否则会出现
/// 「导入时收进来、解析时读不出」的错配。
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    // BOM：UTF-8 与 UTF-16（Windows 记事本「Unicode」另存的就是 UTF-16LE，带 FF FE）
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(rest).ok().map(|s| s.to_string());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return Some(UTF_16LE.decode(rest).0.into_owned());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return Some(UTF_16BE.decode(rest).0.into_owned());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Some(s.to_string());
    }
    for enc in [GB18030, BIG5, SHIFT_JIS] {
        let (text, _, had_errors) = enc.decode(bytes);
        if !had_errors {
            return Some(text.into_owned());
        }
    }
    None
}

/// 这段字节是不是「（可能被截断的）合法 UTF-8」
fn is_valid_utf8_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // 只有在**末尾**被截断（采样切在多字节字符中间）才算合法
        Err(e) => e.error_len().is_none() && e.valid_up_to() > 0,
    }
}

/// 用某个编码解这段字节，且**没有出现替换字符**。
///
/// 末尾最多放宽 2 个字节：采样常常正好切在一个多字节字符中间，那不算「解不出来」。
fn decodes_cleanly(enc: &'static encoding_rs::Encoding, bytes: &[u8]) -> bool {
    for trim in 0..=2usize {
        let Some(end) = bytes.len().checked_sub(trim) else {
            continue;
        };
        if end == 0 {
            continue;
        }
        if !enc.decode(&bytes[..end]).2 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_with_and_without_bom() {
        assert_eq!(decode_text("中文 abc".as_bytes()).unwrap(), "中文 abc");
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("带 BOM".as_bytes());
        assert_eq!(decode_text(&with_bom).unwrap(), "带 BOM");
    }

    #[test]
    fn decodes_utf16_by_bom() {
        let text = "UTF-16 的中文";
        let mut le = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text(&le).unwrap(), text);

        let mut be = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_text(&be).unwrap(), text);
    }

    #[test]
    fn falls_back_to_legacy_chinese_encodings() {
        // “中文” 的 GBK 编码（UTF-8 解不出来）
        assert_eq!(decode_text(&[0xd6, 0xd0, 0xce, 0xc4]).unwrap(), "中文");
    }

    #[test]
    fn binary_returns_none() {
        assert!(decode_text(&[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]).is_none());
        assert!(decode_text(&[]).unwrap().is_empty(), "空文件是空文本，不是二进制");
    }

    /// `sniff_is_text` 与 `decode_text` 必须同进同退：嗅探说「是文本」的，
    /// 解码就得给出内容（否则会出现「收进来却读不出」）。
    #[test]
    fn sniff_and_decode_agree_on_our_encodings() {
        for sample in [
            "中文，逗号。".as_bytes().to_vec(),
            "hello world\n".as_bytes().to_vec(),
            vec![0xd6, 0xd0, 0xce, 0xc4], // GBK 中文
        ] {
            assert!(sniff_is_text(&sample), "应判定为文本: {sample:?}");
            assert!(decode_text(&sample).is_some(), "应能解码: {sample:?}");
        }
    }
}
