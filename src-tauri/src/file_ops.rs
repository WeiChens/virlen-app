use encoding_rs::{CoderResult, Encoding, GBK, SHIFT_JIS, EUC_JP};
use sha2::{Digest, Sha256};
use std::fs;

/// 尝试用指定编码解码字节内容，返回解码后的 String
/// encoding_rs 解码器不会报错（malformed 序列用 U+FFFD 替换），
/// 因此通过检查替换字符的数量来评估解码质量
fn decode_with(encoding: &'static Encoding, bytes: &[u8]) -> Result<String, String> {
    let mut decoder = encoding.new_decoder();
    let mut output = String::with_capacity(
        bytes.len() + bytes.len() / 2,
    );
    // decode_to_string 返回 CoderResult（InputEmpty | OutputFull）
    // 和实际消耗的字节/字符数，不会因 malformed 序列报错
    let (result, _, _) = decoder.decode_to_string(bytes, &mut output, true);
    match result {
        CoderResult::InputEmpty => {
            // 检查替换字符比例：如果超过 5% 的字符被替换，认为编码不匹配
            let replaced = output.chars().filter(|c| *c == '\u{FFFD}').count();
            let ratio = replaced as f64 / output.chars().count().max(1) as f64;
            if ratio > 0.05 {
                // OutputFull 通常不会发生，因为预分配足够；如果发生，回退到简单解码
                Err(format!("Encoding mismatch: too many invalid byte sequences for {}", encoding.name()))
            } else {
                Ok(output)
            }
        }
        CoderResult::OutputFull => {
            // 输出缓冲区满 → 用更大缓冲区重试
            let mut buf = String::with_capacity(bytes.len() * 3);
            let (_, _, _) = decoder.decode_to_string(bytes, &mut buf, true);
            Ok(buf)
        }
    }
}

/// 检测并解码文本文件内容
///
/// 策略：
///   1. 先尝试 UTF-8（快速路径，覆盖大多数场景）
///   2. 检查 BOM（UTF-16 LE/BE）
///   3. 回退检测常见编码：GBK → Shift-JIS → EUC-JP
///   4. 全部失败后检查空字节，区分"二进制文件"和"未知编码"
fn read_file_text(path: &str) -> Result<String, String> {
    let raw = fs::read(path).map_err(|e| {
        format!("Cannot read file '{}': {}", path, e)
    })?;

    // ---- 1. 快速路径：UTF-8（覆盖 95%+ 场景） ----
    if let Ok(s) = String::from_utf8(raw.clone()) {
        return Ok(s);
    }

    // ---- 2. BOM 检测 ----
    // UTF-16LE BOM: 0xFF 0xFE
    if raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
        let encoding = encoding_rs::UTF_16LE;
        return decode_with(encoding, &raw[2..]);
    }
    // UTF-16BE BOM: 0xFE 0xFF
    if raw.len() >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
        let encoding = encoding_rs::UTF_16BE;
        return decode_with(encoding, &raw[2..]);
    }
    // UTF-8 BOM: 0xEF 0xBB 0xBF
    if raw.len() >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
        // 去掉 BOM 后重新按 UTF-8 解析
        return String::from_utf8(raw[3..].to_vec()).map_err(|e| {
            format!(
                "Invalid UTF-8 sequence after BOM in file '{}': {}",
                path, e
            )
        });
    }

    // ---- 3. 回退检测常见非 UTF-8 编码 ----
    // 中文/日文场景覆盖：GBK > Shift-JIS > EUC-JP
    let fallback_encodings: &[&'static Encoding] = &[GBK, SHIFT_JIS, EUC_JP];
    for enc in fallback_encodings {
        if let Ok(decoded) = decode_with(enc, &raw) {
            // 额外校验：解码后的内容不应包含空字节（否则可能是误判）
            if !decoded.contains('\0') {
                return Ok(decoded);
            }
        }
    }

    // ---- 4. 全部失败 → 判断是二进制还是未知编码 ----
    let filename = path.split(&['/', '\\'][..]).last().unwrap_or(path);

    // 含空字节 → 判定为二进制文件
    if raw.contains(&0x00) {
        let preview: Vec<String> =
            raw.iter().take(16).map(|b| format!("{:02x}", b)).collect();
        return Err(format!(
            "❌ Binary file '{}' is not supported. Only plain text files \
             (.txt, .md, .json, .ts, .js, .py, .rs, .css, .scss, .html, .xml, \
             .yaml, .toml, .env, .csv, .sql, .sh, .bat, etc.) can be read or edited. \
             Binary detected: null byte found at offset {} (hex preview: {}...).",
            filename,
            raw.iter().position(|b| *b == 0x00).unwrap_or(0),
            preview.join(" ")
        ));
    }

    // 不含空字节但所有编码尝试都失败 → 未知编码
    Err(format!(
        "Cannot read file '{}': unsupported encoding. \
         The file appears to be a text file but could not be decoded as UTF-8, \
         GBK, Shift-JIS, or EUC-JP. Only UTF-8 encoded text files are guaranteed to work.",
        filename
    ))
}

/// 读取文件内容并返回其 SHA256 哈希（hex 编码）
#[derive(serde::Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub hash: String,
    pub line_count: usize,
    pub byte_size: usize,
}

pub fn read_file(path: &str) -> Result<FileReadResult, String> {
    let raw = read_file_text(path)?;

    // 返回的内容保留原始换行符（CRLF/LF），但 hash 基于归一化后的 LF 内容计算
    let normalized = normalize_content(&raw);

    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        hex::encode(hasher.finalize())
    };

    let line_count = normalized.lines().count();
    let byte_size = raw.len();

    Ok(FileReadResult {
        content: raw,
        hash,
        line_count,
        byte_size,
    })
}

/// 将文件内容归一化为 LF 换行符（\n），
/// 然后计算 hash 供外部使用（不会实际改文件）。
/// `read_file` 返回的 hash 是归一化后的 hash，这样 AI 构造的 old_string
/// 使用 `\n` 就能匹配，无需关注文件实际是 CRLF 还是 LF。
fn normalize_content(content: &str) -> String {
    content.replace("\r\n", "\n")
}

/// 编辑文件：在文件内容中精确查找并替换一段字符串。
///
/// 关键设计：
///   - read_file 返回的是 **归一化（LF）** 内容的 hash
///   - AI 在 old_string/new_string 中统一使用 `\n` (LF)
///   - edit_file 内部对文件内容做同样的归一化后匹配
///   - 写入时保留原始换行符风格（CRLF/LF 保持不变）
///
/// 这样 AI 无需关心文件是 Windows CRLF 还是 Unix LF，都统一用 `\n`。
#[derive(serde::Serialize)]
pub struct FileEditResult {
    pub hash: String,
    pub replaced_count: usize,
    pub line_count: usize,
    /// old_string 在文件中匹配的起始行号（1-indexed），减去 context 行数后
    pub old_start_line: usize,
    /// old_string 前后各加 2 行 context（不足则取全部）
    pub old_string_context: String,
    /// new_string 前后各加 2 行 context（不足则取全部）
    pub new_string_context: String,
}

pub fn edit_file(
    path: &str,
    old_string: &str,
    new_string: &str,
    expected_hash: &str,
    replace_count: usize,
) -> Result<FileEditResult, String> {
    // 1. 读取文件内容（自动检测编码），并检测二进制
    let raw = read_file_text(path)?;

    let normalized = normalize_content(&raw);

    // 2. 冲突检测：用归一化内容的 hash
    let current_hash = {
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        hex::encode(hasher.finalize())
    };

    if current_hash != expected_hash {
        return Err(format!(
            "Conflict: file '{}' has changed since you last read it. \
             Expected SHA256 '{}' but current file has '{}'. \
             Please re-read the file and retry the edit.",
            path, expected_hash, current_hash
        ));
    }

    // 3. 在归一化内容上查找 old_string（AI 统一用 \n）
    let actual_count = normalized.matches(old_string).count();
    if actual_count == 0 {
        // 尝试给出有用的提示
        if normalized.contains("\r\n") {
            return Err(format!(
                "old_string not found in file '{}'. \
                 Note: newlines are being normalized to LF, so use `\\n` not `\\r\\n` in old_string. \
                 The content you want to replace does not exist.",
                path
            ));
        }
        return Err(format!(
            "old_string not found in file '{}'. The content you want to replace does not exist in the file.",
            path
        ));
    }

    if actual_count < replace_count {
        return Err(format!(
            "old_string appears {} time(s) in file '{}', but you requested {} replacement(s). Reduce replace_count or check your old_string.",
            actual_count, path, replace_count
        ));
    }

    // ---- 计算 old_string 的起始行号 ----
    // 归一化内容中第一个匹配位置之前的行数 + 1
    let first_match_pos = normalized.find(old_string).unwrap();
    let raw_old_start_line = normalized[..first_match_pos]
        .lines()
        .count()
        + 1;

    // ---- 提取前后各 2 行 context（基于字节位置，避免行边界对齐问题） ----
    // 当 old_string 从行中间匹配时，用 all_lines 整行切片会导致
    // ctx_before 的完整行与 old_string/new_string 的片段行重叠。
    // 改为直接从 normalized 字符串按字节位置提取前后文。
    const CONTEXT_LINES: usize = 2;
    let match_end = first_match_pos + old_string.len();

    // context before：从匹配位置往前找 CONTEXT_LINES 个换行符
    let ctx_before_raw_start = {
        let mut pos = first_match_pos;
        for _ in 0..CONTEXT_LINES {
            if pos == 0 {
                break;
            }
            match normalized[..pos].rfind('\n') {
                Some(p) => pos = p,
                None => {
                    pos = 0;
                    break;
                }
            }
        }
        // pos 指向 '\n' 的位置（或 0），跳过 '\n' 得到内容起始
        if pos > 0 { pos + 1 } else { 0 }
    };
    let ctx_before_text = &normalized[ctx_before_raw_start..first_match_pos];

    // context after：从匹配结束位置往后找 CONTEXT_LINES 个换行符
    let ctx_after_raw_end = {
        let mut pos = match_end;
        for _ in 0..CONTEXT_LINES {
            if pos >= normalized.len() {
                break;
            }
            match normalized[pos..].find('\n') {
                Some(p) => pos = pos + p + 1, // 跳过 '\n'
                None => {
                    pos = normalized.len();
                    break;
                }
            }
        }
        pos
    };
    let ctx_after_text = &normalized[match_end..ctx_after_raw_end];

    // 构造 context 字符串（直接拼接，不经过 all_lines 切片）
    let old_string_context = format!("{}{}{}", ctx_before_text, old_string, ctx_after_text);
    let new_string_context = format!("{}{}{}", ctx_before_text, new_string, ctx_after_text);

    // 调整起始行号 = 原始起始行 - context 前置行数
    let ctx_before = CONTEXT_LINES.min(raw_old_start_line.saturating_sub(1));
    let old_start_line = raw_old_start_line - ctx_before;

    // 4. 在归一化内容上执行替换
    let mut edited_normalized = normalized.clone();
    let mut replaced = 0;
    if replace_count == usize::MAX {
        edited_normalized = normalized.replace(old_string, new_string);
        replaced = actual_count;
    } else {
        for _ in 0..replace_count {
            if let Some(pos) = edited_normalized.find(old_string) {
                let before = &edited_normalized[..pos];
                let after = &edited_normalized[pos + old_string.len()..];
                edited_normalized = format!("{}{}{}", before, new_string, after);
                replaced += 1;
            } else {
                break;
            }
        }
    }

    // 5. 写回时保留原始换行符风格
    //    如果原始文件是 CRLF，写回也用 CRLF
    let final_content = if raw.contains("\r\n") {
        edited_normalized.replace("\n", "\r\n")
    } else {
        edited_normalized.clone()
    };

    fs::write(path, &final_content)
        .map_err(|e| format!("Cannot write file '{}': {}", path, e))?;

    // 6. 返回归一化后的 hash（与 read_file 一致）
    let new_hash = {
        let mut hasher = Sha256::new();
        hasher.update(edited_normalized.as_bytes());
        hex::encode(hasher.finalize())
    };

    let line_count = edited_normalized.lines().count();

    Ok(FileEditResult {
        hash: new_hash,
        replaced_count: replaced,
        line_count,
        old_start_line,
        old_string_context,
        new_string_context,
    })
}
