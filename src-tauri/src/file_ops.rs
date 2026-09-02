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

/// 读取文件内容并返回其 hash10（SHA-256 前 10 位 hex）
#[derive(serde::Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub hash10: String,
    pub line_count: usize,
    pub byte_size: usize,
}

pub fn read_file(path: &str) -> Result<FileReadResult, String> {
    let raw = read_file_text(path)?;

    // 返回的内容保留原始换行符（CRLF/LF），但 hash10 基于归一化后的 LF 内容计算
    let normalized = normalize_content(&raw);

    let hash10 = compute_hash10(&normalized);

    let line_count = normalized.lines().count();
    let byte_size = raw.len();

    Ok(FileReadResult {
        content: raw,
        hash10,
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

/// 计算归一化内容的 hash10（SHA-256 前 10 位 hex）
fn compute_hash10(normalized: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let full = hex::encode(hasher.finalize());
    // hash10 = SHA-256 前 10 位 hex（40 bit），仅用于「文件是否被修改」的冲突检测，
    // 可大幅减少 AI 上下文中的 token 消耗。
    full[..10].to_string()
}

/// 单次编辑的结果（不含文件级 hash/line_count，用于多编辑场景）
#[derive(serde::Serialize, Clone)]
pub struct SingleEditResult {
    pub replaced_count: usize,
    pub old_start_line: usize,
    pub old_string_context: String,
    pub new_string_context: String,
}

/// 多编辑入口项（从 JSON 反序列化）
#[derive(serde::Deserialize)]
pub struct EditEntry {
    pub old_string: String,
    pub new_string: String,
    #[serde(default = "default_one")]
    pub replace_count: usize,
}

fn default_one() -> usize {
    1
}

/// 多编辑结果
#[derive(serde::Serialize)]
pub struct FileEditMultiResult {
    pub hash10: String,
    pub line_count: usize,
    pub edits: Vec<SingleEditResult>,
}

/// 在归一化内容上执行一次查找替换，返回上下文和行号信息。
/// 不读写文件，仅修改 `normalized` 字符串。
fn apply_single_edit(
    normalized: &mut String,
    old_string: &str,
    new_string: &str,
    replace_count: usize,
) -> Result<SingleEditResult, String> {
    let actual_count = normalized.matches(old_string).count();
    if actual_count == 0 {
        return Err(format!(
            "old_string not found. The content you want to replace does not exist in the file."
        ));
    }

    let replace_all = replace_count == usize::MAX;
    if !replace_all && actual_count < replace_count {
        return Err(format!(
            "old_string appears {} time(s), but you requested {} replacement(s). \
             Reduce replace_count or check your old_string.",
            actual_count, replace_count
        ));
    }

    // ---- 计算 old_string 的起始行号 ----
    let first_match_pos = normalized.find(old_string).unwrap();
    let raw_old_start_line = normalized[..first_match_pos].lines().count() + 1;

    // ---- 提取前后各 2 行 context（基于字节位置） ----
    const CONTEXT_LINES: usize = 2;
    let match_end = first_match_pos + old_string.len();

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
        if pos > 0 { pos + 1 } else { 0 }
    };

    let ctx_after_raw_end = {
        let mut pos = match_end;
        for _ in 0..CONTEXT_LINES {
            if pos >= normalized.len() {
                break;
            }
            match normalized[pos..].find('\n') {
                Some(p) => pos = pos + p + 1,
                None => {
                    pos = normalized.len();
                    break;
                }
            }
        }
        pos
    };

    // 提前克隆上下文文本，避免后续修改 normalized 时借用冲突
    let ctx_before_text = normalized[ctx_before_raw_start..first_match_pos].to_string();
    let ctx_after_text = normalized[match_end..ctx_after_raw_end].to_string();

    let old_string_context = format!("{}{}{}", ctx_before_text, old_string, ctx_after_text);
    let new_string_context = format!("{}{}{}", ctx_before_text, new_string, ctx_after_text);

    let ctx_before = CONTEXT_LINES.min(raw_old_start_line.saturating_sub(1));
    let old_start_line = raw_old_start_line - ctx_before;

    // ---- 执行替换 ----
    let replaced = if replace_all {
        *normalized = normalized.replace(old_string, new_string);
        actual_count
    } else {
        let mut replaced = 0;
        for _ in 0..replace_count {
            if let Some(pos) = normalized.find(old_string) {
                let before = &normalized[..pos];
                let after = &normalized[pos + old_string.len()..];
                *normalized = format!("{}{}{}", before, new_string, after);
                replaced += 1;
            } else {
                break;
            }
        }
        replaced
    };

    Ok(SingleEditResult {
        replaced_count: replaced,
        old_start_line,
        old_string_context,
        new_string_context,
    })
}

pub fn edit_file_multi(
    path: &str,
    edits: &[EditEntry],
    expected_hash: &str,
) -> Result<FileEditMultiResult, String> {
    if edits.is_empty() {
        return Err("edits must contain at least one edit".to_string());
    }

    let raw = read_file_text(path)?;
    let mut normalized = normalize_content(&raw);

    // 冲突检测
    let current_hash10 = compute_hash10(&normalized);
    if current_hash10 != expected_hash {
        return Err(format!(
            "Conflict: file '{}' has changed since you last read it. \
             Expected hash10 '{}' but current file has '{}'. \
             Please re-read the file and retry the edit.",
            path, expected_hash, current_hash10
        ));
    }

    // 逐个应用编辑
    let mut results: Vec<SingleEditResult> = Vec::with_capacity(edits.len());
    for (i, entry) in edits.iter().enumerate() {
        let mut count = entry.replace_count;
        if count == 0 {
            count = usize::MAX;
        }
        let result = apply_single_edit(
            &mut normalized,
            &entry.old_string,
            &entry.new_string,
            count,
        )
        .map_err(|e| format!("Edit #{} (old_string starts with {:?}): {}", i + 1, entry.old_string.chars().take(40).collect::<String>(), e))?;
        results.push(result);
    }

    // 写回
    let new_hash10 = compute_hash10(&normalized);
    let line_count = normalized.lines().count();
    let final_content = if raw.contains("\r\n") {
        normalized.replace("\n", "\r\n")
    } else {
        normalized
    };

    fs::write(path, &final_content)
        .map_err(|e| format!("Cannot write file '{}': {}", path, e))?;

    Ok(FileEditMultiResult {
        hash10: new_hash10,
        line_count,
        edits: results,
    })
}

/// 写入文件（完整覆盖），自动创建父目录。
/// 返回归一化（LF）内容的 hash10，与 read_file/edit_file_multi 一致，
/// 可直接用作后续 edit_file_multi 的 expected_hash。
#[derive(serde::Serialize)]
pub struct FileWriteResult {
    pub hash10: String,
    pub line_count: usize,
    pub byte_size: usize,
    pub existed: bool,
}

pub fn write_file(path: &str, content: &str) -> Result<FileWriteResult, String> {
    // 1. 创建父目录（兼容 Windows 反斜杠路径）
    let normalized_path = path.replace('\\', "/");
    if let Some(parent) = normalized_path.rfind('/') {
        let parent_dir = &normalized_path[..parent];
        if !parent_dir.is_empty() {
            std::fs::create_dir_all(parent_dir)
                .map_err(|e| format!("Cannot create directory '{}': {}", parent_dir, e))?;
        }
    }

    // 2. 记录文件是否已存在
    let existed = std::path::Path::new(path).exists();

    // 3. 写入内容（保留用户给定的换行符）
    std::fs::write(path, content)
        .map_err(|e| format!("Cannot write file '{}': {}", path, e))?;

    // 4. 计算归一化 hash10（与 read_file/edit_file_multi 一致）
    let normalized = normalize_content(content);
    let hash10 = compute_hash10(&normalized);

    Ok(FileWriteResult {
        hash10,
        line_count: normalized.lines().count(),
        byte_size: content.len(),
        existed,
    })
}
