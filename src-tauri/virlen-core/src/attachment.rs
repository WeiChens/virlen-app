//! 图片附件外置存放（P0-1）。
//!
//! ## 为什么
//! 用户贴的图片过去是 `data:image/png;base64,...` 直接躺在 `messages.content` JSON 里：
//! 一张 1 MB 的图 = 1.37 MB 文本，同时污染 SQLite 主库 / WAL / 备份 / `text_plain` 索引，
//! 每次分页与 IPC 都要把这段 base64 搬一遍。
//!
//! 这里把字节挪到磁盘（**内容寻址**，天然去重），数据库里只留一个稳定引用：
//!
//! ```text
//! {"type":"image_url","image_url":{"url":"attachment://<sha256>.<ext>","detail":"auto"}}
//! ```
//!
//! ## 三条硬约定
//! 1. **写入边界外置**：所有落库路径（引擎直落 / 前端 `cmd_append_messages`）在写前调用
//!    [`AttachmentStore::externalize_message`]，因此**库里永远不会再出现新的 base64 图片**，
//!    而内存里的消息保持原样（前端正在渲染的 data URL 不会突然失效）。
//! 2. **读取时按需还原**：只有「要交给模型 / 浏览器加载」的地方才调用
//!    [`AttachmentStore::resolve_message`]（引擎组装请求、UI 走自定义协议）。
//!    普通分页 / 检索拿到的仍是引用，IPC 体积与库体积一起降下来。
//! 3. **失败只降级、不阻断**：单张图解码失败 / 超限 / 参数不认识 → 保持原样（继续内联）；
//!    引用指向的文件丢失 → 还原时降级成一句文本提示，绝不把解析不了的 `attachment://` 递给上游。
//!
//! ## 为什么不用数据库表
//! 引用自带全部信息（内容哈希 + 扩展名），不需要注册表、不需要事务、不引入第二处真相。
//! 代价是「没有引用计数」，回收只能靠外部维护（见 [`AttachmentStore::orphans`] 的说明）。
//!
//! ⚠️ 本文件零 `tauri::`：GUI 的自定义协议处理在 `virlen-app` 的 `commands/attachment.rs`。

use crate::agent::types::Message;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// 数据库里的引用前缀。必须与前端 `src/domain/files/attachment-src.ts` 的常量逐字一致。
pub const PREFIX: &str = "attachment://";

/// 单张图上限：与前端 `local-image-service.ts` 的 `MAX_IMAGE_BYTES` 同值。
/// 超过就**不**外置（继续内联）—— 宁可让这一条消息大一点，也不把几十 MB 的图写进附件目录。
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

/// 认识的图片类型（mime → 扩展名）。只处理图片：其余 `data:` URL 与本模块无关。
const MIME_EXT: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/bmp", "bmp"),
    ("image/avif", "avif"),
    ("image/svg+xml", "svg"),
];

/// 扩展名 → mime（还原时用；与 [`MIME_EXT`] 必须一一对应）
const EXT_MIME: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
];

/// 这份引用是不是本模块产出的（`attachment://...`）
pub fn is_ref(url: &str) -> bool {
    url.starts_with(PREFIX)
}

/// `attachment://<sha256>.<ext>` → `<sha256>.<ext>`（形状不合法时为 `None`）
pub fn parse_ref(url: &str) -> Option<&str> {
    let name = url.strip_prefix(PREFIX)?;
    is_safe_name(name).then_some(name)
}

/// 附件名白名单：64 位小写 hex + `.` + 认识的扩展名。
///
/// **这是唯一的路径校验**（协议处理 / 读盘都走它）：名字里不可能出现分隔符、`..`、盘符，
/// 所以 `root.join(name)` 永远落在附件目录内。
fn is_safe_name(name: &str) -> bool {
    let Some((hash, ext)) = name.rsplit_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && EXT_MIME.iter().any(|(known, _)| *known == ext)
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    let mime = mime.trim().to_ascii_lowercase();
    MIME_EXT
        .iter()
        .find(|(known, _)| *known == mime)
        .map(|(_, ext)| *ext)
}

fn mime_for_ext(ext: &str) -> Option<&'static str> {
    EXT_MIME
        .iter()
        .find(|(known, _)| *known == ext)
        .map(|(_, mime)| *mime)
}

/// `data:<mime>[;param];base64,<payload>` → `(mime, payload)`；不是 base64 数据 URL 则为 `None`
fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let mime = parts.next().unwrap_or("");
    if !parts.any(|part| part.trim().eq_ignore_ascii_case("base64")) {
        return None;
    }
    Some((mime, payload))
}

/// 去掉 base64 里可能夹带的空白（部分前端序列化会折行）
fn strip_whitespace(payload: &str) -> String {
    if !payload
        .bytes()
        .any(|b| b == b'\n' || b == b'\r' || b == b' ')
    {
        return payload.to_string();
    }
    payload
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// 外置结果记忆表：**同一条消息每轮发送都会被重新外置**（引擎把整份历史交给写库路径），
/// 没有它就是把同一张图反复 base64 解码 + SHA-256。
///
/// 键是**完整的 data URL**（精确匹配，不存在碰撞风险）；一条超大图不记
/// （[`MEMO_MAX_ENTRY`]），总占用超过 [`MEMO_MAX_BYTES`] 时按写入顺序淘汰。
#[derive(Debug, Default)]
struct RefMemo {
    /// `(data URL, 附件名)`，按写入顺序排列（头部最旧）
    entries: Vec<(String, String)>,
    /// `entries` 里字符串的总字节数（用来封顶）
    bytes: usize,
}

/// 记忆表总容量上限（字节）。消息本身已经存着一份 URL，这里再存一份，所以不能无限长。
const MEMO_MAX_BYTES: usize = 64 * 1024 * 1024;
/// 单条超过这个大小的 URL 不进记忆表（它一条就能把整张表挤空）
const MEMO_MAX_ENTRY: usize = 24 * 1024 * 1024;

impl RefMemo {
    fn get(&self, url: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(key, _)| key == url)
            .map(|(_, name)| name.as_str())
    }

    fn insert(&mut self, url: &str, name: &str) {
        let cost = url.len() + name.len();
        if cost > MEMO_MAX_ENTRY || self.get(url).is_some() {
            return;
        }
        self.entries.push((url.to_string(), name.to_string()));
        self.bytes += cost;
        // FIFO 淘汰（表很小，`remove(0)` 的搬移可忽略）
        while self.bytes > MEMO_MAX_BYTES && self.entries.len() > 1 {
            let (old_url, old_name) = self.entries.remove(0);
            self.bytes -= old_url.len() + old_name.len();
        }
    }

    fn forget(&mut self, url: &str) {
        if let Some(index) = self.entries.iter().position(|(key, _)| key == url) {
            let (old_url, old_name) = self.entries.remove(index);
            self.bytes -= old_url.len() + old_name.len();
        }
    }
}

/// 附件仓库（值类型：根目录 = `<数据目录>/attachments`）
#[derive(Clone, Debug)]
pub struct AttachmentStore {
    root: PathBuf,
    /// 外置结果记忆表（`Arc` 让 clone 出来的句柄共享同一份，否则每轮都是空表）
    memo: Arc<Mutex<RefMemo>>,
}

impl AttachmentStore {
    /// `data_dir` 是宿主的数据目录（与 `virlen.db` 同级）
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("attachments"),
            memo: Arc::new(Mutex::new(RefMemo::default())),
        }
    }

    /// 拿记忆表（中毒也继续用：图片外置绝不该因为一次 panic 就彻底失效）
    fn memo(&self) -> std::sync::MutexGuard<'_, RefMemo> {
        self.memo.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn memo_get(&self, url: &str) -> Option<String> {
        self.memo().get(url).map(str::to_string)
    }

    fn memo_put(&self, url: &str, name: &str) {
        self.memo().insert(url, name);
    }

    fn memo_forget(&self, url: &str) {
        self.memo().forget(url);
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 写入一份字节（内容寻址，已存在则跳过）→ 返回附件名 `<sha256>.<ext>`
    fn write_bytes(&self, bytes: &[u8], ext: &str) -> Result<String, String> {
        let digest = Sha256::digest(bytes);
        let hash = hex::encode(digest);
        let name = format!("{}.{}", hash, ext);
        let path = self.root.join(&name);
        if path.exists() {
            return Ok(name);
        }
        std::fs::create_dir_all(&self.root)
            .map_err(|e| format!("创建附件目录失败: {}", e))?;
        // 先写 `.part` 再 rename：崩溃 / 并发只可能留下临时文件，绝不会出现半张图冒充完整附件
        let tmp = self.root.join(format!("{}.{}.part", hash, ext));
        std::fs::write(&tmp, bytes).map_err(|e| format!("写入附件失败: {}", e))?;
        match std::fs::rename(&tmp, &path) {
            Ok(()) => Ok(name),
            // 并发下别人先落地了同名文件：内容相同，删掉自己的临时文件即可
            Err(_) if path.exists() => {
                let _ = std::fs::remove_file(&tmp);
                Ok(name)
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                Err(format!("落盘附件失败: {}", e))
            }
        }
    }

    /// 把一个 `content` 块里的内联图片外置（就地改写）。
    /// 返回 true 表示这一块真的被改写了。
    fn externalize_block(&self, block: &mut Value) -> bool {
        let Some(object) = block.as_object_mut() else {
            return false;
        };
        if object.get("type").and_then(Value::as_str) != Some("image_url") {
            return false;
        }
        let Some(image) = object.get_mut("image_url").and_then(Value::as_object_mut) else {
            return false;
        };
        let Some(url) = image.get("url").and_then(Value::as_str) else {
            return false;
        };
        // 已经是引用 / 远程 URL / 非图片：不碰
        let Some((mime, payload)) = split_data_url(url) else {
            return false;
        };
        let Some(ext) = ext_for_mime(mime) else {
            return false;
        };
        // 命中记忆表 → 跳过整段「base64 解码 + SHA-256」；但必须再确认文件还在
        //（被 GC / 手删时不能把死引用写进库，那种引用还原时只会降级成文案）。
        if let Some(name) = self.memo_get(url) {
            if self.root.join(&name).is_file() {
                let reference = format!("{}{}", PREFIX, name);
                image.insert("url".into(), Value::String(reference));
                return true;
            }
            self.memo_forget(url);
        }
        let Ok(bytes) = STANDARD.decode(strip_whitespace(payload)) else {
            eprintln!("[attachment] 图片 base64 解码失败（{}），保持内联", mime);
            return false;
        };
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return false;
        }
        let name = match self.write_bytes(&bytes, ext) {
            Ok(name) => name,
            Err(e) => {
                // 附件盘不可用不能拖垮聊天：保持内联，用户至少还能发消息
                eprintln!("[attachment] 外置图片失败，保持内联: {}", e);
                return false;
            }
        };
        self.memo_put(url, &name);
        image.insert("url".into(), Value::String(format!("{}{}", PREFIX, name)));
        true
    }

    /// 外置一条消息里的全部内联图片（就地改写），返回外置的块数
    pub fn externalize_message(&self, message: &mut Message) -> usize {
        let Value::Array(blocks) = &mut message.content else {
            return 0;
        };
        let mut changed = 0;
        for block in blocks.iter_mut() {
            if self.externalize_block(block) {
                changed += 1;
            }
        }
        changed
    }

    /// 外置一批消息（返回总块数）；`Message` 没有图片时零开销
    pub fn externalize_messages(&self, messages: &mut [Message]) -> usize {
        messages
            .iter_mut()
            .map(|message| self.externalize_message(message))
            .sum()
    }

    /// 读一份附件字节 + mime（协议处理 / 还原共用）
    pub fn read(&self, name: &str) -> Result<(Vec<u8>, &'static str), String> {
        if !is_safe_name(name) {
            return Err("非法的附件引用".to_string());
        }
        let ext = name.rsplit('.').next().unwrap_or_default();
        let mime = mime_for_ext(ext).ok_or_else(|| "未知附件类型".to_string())?;
        let bytes =
            std::fs::read(self.root.join(name)).map_err(|e| format!("读取附件失败: {}", e))?;
        Ok((bytes, mime))
    }

    /// 把一个块里的引用还原成内联 data URL。
    ///
    /// 文件丢失 / 引用损坏时**降级成文本块**：上游拿到一个无法解析的 `attachment://` 只会报
    /// 「图片无法加载」甚至 400，不如明确告诉模型「这张图丢了」。
    fn resolve_block(&self, block: &Value) -> Option<Value> {
        let url = block.get("image_url")?.get("url")?.as_str()?;
        let name = parse_ref(url)?;
        match self.read(name) {
            Ok((bytes, mime)) => {
                let mut next = block.clone();
                let data = format!("data:{};base64,{}", mime, STANDARD.encode(bytes));
                next["image_url"]["url"] = Value::String(data);
                Some(next)
            }
            Err(e) => {
                eprintln!("[attachment] 图片引用 {} 不可用，降级为文本: {}", name, e);
                Some(json!({
                    "type": "text",
                    "text": format!("[图片不可用: {}]", name),
                }))
            }
        }
    }

    /// 还原一条消息里的全部图片引用（返回新 content；无引用时原样返回，零拷贝）
    pub fn resolve_content(&self, content: &Value) -> Value {
        let Value::Array(blocks) = content else {
            return content.clone();
        };
        if !blocks.iter().any(|block| {
            block
                .get("image_url")
                .and_then(|image| image.get("url"))
                .and_then(Value::as_str)
                .is_some_and(is_ref)
        }) {
            return content.clone();
        }
        Value::Array(
            blocks
                .iter()
                .map(|block| self.resolve_block(block).unwrap_or_else(|| block.clone()))
                .collect(),
        )
    }

    /// 还原一条消息的图片引用（就地改写），返回改写的块数
    pub fn resolve_message(&self, message: &mut Message) -> usize {
        if !message_has_ref(message) {
            return 0;
        }
        let before = message.content.clone();
        message.content = self.resolve_content(&before);
        count_changed(&before, &message.content)
    }

    /// 还原一批消息
    pub fn resolve_messages(&self, messages: &mut [Message]) -> usize {
        messages
            .iter_mut()
            .map(|message| self.resolve_message(message))
            .sum()
    }

    /// 列出目录里所有附件名（供外部维护 / 诊断用；本模块不做自动回收）
    pub fn list_names(&self) -> Result<Vec<String>, String> {
        let dir = match std::fs::read_dir(&self.root) {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("读取附件目录失败: {}", e)),
        };
        let mut names: Vec<String> = dir
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| is_safe_name(name))
            .collect();
        names.sort();
        Ok(names)
    }

    /// 目录占用：`(文件数, 总字节)`。设置页展示“图片附件占了多少盘”。
    ///
    /// 只统计合规命名的文件（`.part` 临时件不算——它们要么马上改名，要么被 GC 清掉）。
    pub fn usage(&self) -> Result<(usize, u64), String> {
        let dir = match std::fs::read_dir(&self.root) {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
            Err(e) => return Err(format!("读取附件目录失败: {}", e)),
        };
        let mut files = 0usize;
        let mut bytes = 0u64;
        for entry in dir.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !is_safe_name(&name) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
        Ok((files, bytes))
    }

    /// 回收没有被任何消息引用的附件。
    ///
    /// ## 为什么需要
    /// 内容寻址解决了「同一张图只存一份」，但解决不了「没人引用了」：删会话 / 删消息 /
    /// 整表回写都会让旧图片失去引用，文件却永久留在磁盘上（库变小了，盘没变小）。
    ///
    /// ## 安全阀（三道）
    /// 1. 只认合规文件名（`is_safe_name`）：不是本模块写的东西一律不碰；
    /// 2. `grace`：写入时间不足 `grace` 的文件即使暂时没被引用也跳过 —— 引擎是**先把图落盘、
    ///    再写 DB 行**，没有这道阀会删掉「正在发送」的图；
    /// 3. 读不到元数据就跳过（宁可不删）。
    pub fn gc(&self, referenced: &HashSet<String>, grace: Duration) -> Result<GcReport, String> {
        let dir = match std::fs::read_dir(&self.root) {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(GcReport::default()),
            Err(e) => return Err(format!("读取附件目录失败: {}", e)),
        };
        let now = SystemTime::now();
        let mut report = GcReport::default();
        for entry in dir.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let is_part = name.ends_with(".part");
            if !is_part && !is_safe_name(&name) {
                continue; // 不是我们写的文件：不碰
            }
            if referenced.contains(&name) {
                report.kept += 1;
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                report.skipped_unknown += 1;
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            // 未来的 mtime（时钟回拨）也算“太新”：宁可跳过
            let young = meta
                .modified()
                .ok()
                .and_then(|mtime| now.duration_since(mtime).ok())
                .map(|age| age < grace)
                .unwrap_or(true);
            if young {
                report.skipped_young += 1;
                continue;
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => {
                    report.freed_bytes += meta.len();
                    if is_part {
                        report.removed_parts += 1;
                    } else {
                        report.removed += 1;
                    }
                }
                // 被别的进程删掉了 / 被占用：不算失败，下次再清
                Err(_) => report.skipped_unknown += 1,
            }
        }
        Ok(report)
    }
}

/// 从一份 `content` 里收集所有附件引用名（`<sha256>.<ext>`），返回新增条数。
///
/// 只认 `image_url.url`（本模块外置的唯一位置）；形状不合法的引用不计（GC 不会因为
/// 库里有一条脏引用就误删/误留）。
pub fn collect_refs(content: &Value, out: &mut HashSet<String>) -> usize {
    let Value::Array(blocks) = content else {
        return 0;
    };
    let mut added = 0;
    for block in blocks {
        let Some(url) = block
            .get("image_url")
            .and_then(|image| image.get("url"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if let Some(name) = parse_ref(url) {
            if out.insert(name.to_string()) {
                added += 1;
            }
        }
    }
    added
}

/// 一次附件回收的结果（设置页展示用）
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GcReport {
    /// 删掉的孤儿附件个数
    pub removed: usize,
    /// 删掉的临时文件个数（`.part`）
    pub removed_parts: usize,
    /// 释放的字节数
    pub freed_bytes: u64,
    /// 仍被引用的附件个数
    pub kept: usize,
    /// 因“太新”（写入不足 grace）而跳过的个数
    pub skipped_young: usize,
    /// 因读不到元数据 / 删除失败而跳过的个数
    pub skipped_unknown: usize,
}

/// 消息里是否含图片引用（廉价预判，避免每条消息都 clone 一次 content）
fn message_has_ref(message: &Message) -> bool {
    match &message.content {
        Value::Array(blocks) => blocks.iter().any(|block| {
            block
                .get("image_url")
                .and_then(|image| image.get("url"))
                .and_then(Value::as_str)
                .is_some_and(is_ref)
        }),
        _ => false,
    }
}

fn count_changed(before: &Value, after: &Value) -> usize {
    match (before, after) {
        (Value::Array(old), Value::Array(new)) => old
            .iter()
            .zip(new.iter())
            .filter(|(a, b)| a != b)
            .count(),
        _ => 0,
    }
}

// ==================== 进程级实例（只给 GUI 的自定义协议用）====================

static GLOBAL: OnceLock<AttachmentStore> = OnceLock::new();

/// 启动时登记数据目录（重复调用只认第一次：协议处理器拿到的必须是同一份根）
pub fn init_global(data_dir: &Path) {
    let _ = GLOBAL.set(AttachmentStore::new(data_dir));
}

/// 取进程级实例（GUI 协议处理 / 命令用；未初始化时为 `None`）
pub fn global() -> Option<&'static AttachmentStore> {
    GLOBAL.get()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::File;
    use std::io::Write;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "virlen_attachment_{}_{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn message_with_image(url: &str) -> Message {
        Message {
            id: "m1".into(),
            role: "user".into(),
            content: json!([
                { "type": "text", "text": "看图" },
                { "type": "image_url", "image_url": { "url": url, "detail": "auto" } },
            ]),
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: 1,
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: None,
            image_vision_analyze_result: None,
        }
    }

    fn png_data_url(bytes: &[u8]) -> String {
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    fn url_of(message: &Message) -> &str {
        message.content[1]["image_url"]["url"].as_str().unwrap()
    }

    #[test]
    fn externalize_then_resolve_roundtrip() {
        let dir = temp_dir("roundtrip");
        let store = AttachmentStore::new(&dir);
        let bytes = b"\x89PNG\r\n\x1a\nfake-image-bytes";
        let mut message = message_with_image(&png_data_url(bytes));

        assert_eq!(store.externalize_message(&mut message), 1);
        let reference = url_of(&message).to_string();
        assert!(reference.starts_with(PREFIX), "{reference}");
        // 引用只由内容哈希构成：同一份字节永远同一个名字（去重）
        assert_eq!(
            reference,
            format!("{}{}.png", PREFIX, hex::encode(Sha256::digest(bytes)))
        );

        // 文本块不受影响
        assert_eq!(message.content[0]["text"], "看图");

        assert_eq!(store.resolve_message(&mut message), 1);
        assert_eq!(url_of(&message), png_data_url(bytes));
    }

    #[test]
    fn externalize_is_idempotent_and_deduplicates() {
        let dir = temp_dir("dedupe");
        let store = AttachmentStore::new(&dir);
        let bytes = b"same-bytes";
        let mut first = message_with_image(&png_data_url(bytes));
        let mut second = message_with_image(&png_data_url(bytes));

        assert_eq!(store.externalize_message(&mut first), 1);
        assert_eq!(store.externalize_message(&mut second), 1);
        assert_eq!(url_of(&first), url_of(&second));
        // 再次外置不再改写（已经是引用）
        assert_eq!(store.externalize_message(&mut first), 0);
        assert_eq!(store.list_names().unwrap().len(), 1);
    }

    /// 同一条消息每轮发送都会重新外置：命中记忆表必须跳过解码 + 哈希，但不能盲信它
    /// （文件被 GC / 手删时要重新落盘，否则写进库的就是一个永远加载不出来的死引用）。
    #[test]
    fn memo_reuses_the_ref_but_verifies_the_file() {
        let dir = temp_dir("memo");
        let store = AttachmentStore::new(&dir);
        let url = png_data_url(b"memo-bytes");

        let mut first = message_with_image(&url);
        assert_eq!(store.externalize_message(&mut first), 1);
        let reference = url_of(&first).to_string();
        let name = reference.trim_start_matches(PREFIX).to_string();
        let path = dir.join("attachments").join(&name);
        assert!(path.is_file());

        // ① 同样的 URL 再来一次（clone 出来的句柄也必须共享同一张表）
        let mut again = message_with_image(&url);
        assert_eq!(store.clone().externalize_message(&mut again), 1);
        assert_eq!(url_of(&again), reference);

        // ② 文件被删：记忆表命中也要重新落盘
        std::fs::remove_file(&path).unwrap();
        let mut rebuilt = message_with_image(&url);
        assert_eq!(store.externalize_message(&mut rebuilt), 1);
        assert_eq!(url_of(&rebuilt), reference);
        assert!(path.is_file(), "死引用必须重建，不能只信记忆表");

        // ③ 字节变一个字符 → 键不同 → 换一个新附件（内容寻址，不复用旧名字）
        let mut changed = message_with_image(&png_data_url(b"memo-bytez"));
        assert_eq!(store.externalize_message(&mut changed), 1);
        assert_ne!(url_of(&changed), reference);
    }

    #[test]
    fn non_image_blocks_and_remote_urls_are_left_alone() {
        let dir = temp_dir("untouched");
        let store = AttachmentStore::new(&dir);
        let mut message = message_with_image("https://example.com/a.png");
        assert_eq!(store.externalize_message(&mut message), 0);
        assert_eq!(url_of(&message), "https://example.com/a.png");

        // 非图片 data URL（如 data:text/plain）不认
        let mut text = message_with_image("data:text/plain;base64,aGk=");
        assert_eq!(store.externalize_message(&mut text), 0);
        assert!(url_of(&text).starts_with("data:text/plain"));
    }

    #[test]
    fn broken_base64_stays_inline() {
        let dir = temp_dir("broken");
        let store = AttachmentStore::new(&dir);
        let mut message = message_with_image("data:image/png;base64,@@@not-base64@@@");
        assert_eq!(store.externalize_message(&mut message), 0);
        assert_eq!(url_of(&message), "data:image/png;base64,@@@not-base64@@@");
    }

    #[test]
    fn whitespace_in_payload_is_tolerated() {
        let dir = temp_dir("whitespace");
        let store = AttachmentStore::new(&dir);
        let payload = STANDARD.encode(b"wrapped-bytes");
        let (head, tail) = payload.split_at(4);
        let wrapped = format!("{head}\n{tail}");
        let mut message = message_with_image(&format!("data:image/png;base64,{wrapped}"));
        assert_eq!(store.externalize_message(&mut message), 1);
        assert_eq!(
            url_of(&message),
            format!(
                "{}{}.png",
                PREFIX,
                hex::encode(Sha256::digest(b"wrapped-bytes"))
            )
        );
    }

    #[test]
    fn missing_file_degrades_to_text() {
        let dir = temp_dir("missing");
        let store = AttachmentStore::new(&dir);
        let mut message = message_with_image(&format!(
            "{}deadbeef{}.png",
            PREFIX,
            "0".repeat(56)
        ));
        // 引用的文件不存在 → 还原成文本块（不给上游留无法解析的 scheme）
        store.resolve_message(&mut message);
        assert_eq!(message.content[1]["type"], "text");
        assert!(message.content[1]["text"]
            .as_str()
            .unwrap()
            .contains("图片不可用"));
    }

    #[test]
    fn unsafe_names_are_rejected() {
        assert!(!is_safe_name("../etc/passwd"));
        assert!(!is_safe_name("abc.png"));
        assert!(!is_safe_name(&format!("{}.png", "A".repeat(64)))); // 大写 hex 不认
        assert!(!is_safe_name(&format!("{}.exe", "a".repeat(64))));
        assert!(is_safe_name(&format!("{}.png", "a".repeat(64))));
        assert!(parse_ref(&format!("{}x.png", PREFIX)).is_none());
        assert!(parse_ref("http://x/a.png").is_none());
    }

    #[test]
    fn string_content_is_untouched() {
        let dir = temp_dir("string");
        let store = AttachmentStore::new(&dir);
        let mut message = message_with_image("ignored");
        message.content = json!("pure text");
        assert_eq!(store.externalize_message(&mut message), 0);
        assert_eq!(store.resolve_message(&mut message), 0);
        assert_eq!(message.content, json!("pure text"));
    }

    #[test]
    fn resolve_content_is_a_noop_without_refs() {
        let dir = temp_dir("noref");
        let store = AttachmentStore::new(&dir);
        let content = json!([{ "type": "text", "text": "hi" }]);
        assert_eq!(store.resolve_content(&content), content);
    }

    /// 写一个附件文件并把它改成「一小时前」，模拟“早就没人引用的孤儿”
    fn write_old_file(store: &AttachmentStore, name: &str, bytes: &[u8]) {
        std::fs::create_dir_all(store.root()).unwrap();
        let path = store.root().join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        drop(file);
        let old = SystemTime::now() - Duration::from_secs(3600);
        let f = File::options().write(true).open(&path).unwrap();
        f.set_modified(old).unwrap();
    }

    #[test]
    fn collect_refs_reads_image_urls_only() {
        let content = json!([
            { "type": "text", "text": "hi" },
            { "type": "image_url", "image_url": { "url": format!("{}deadbeef{}.png", PREFIX, "0".repeat(56)) } },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
            { "type": "image_url", "image_url": { "url": "attachment://not-a-valid-name.png" } },
        ]);
        let mut refs = HashSet::new();
        assert_eq!(collect_refs(&content, &mut refs), 1);
        assert_eq!(refs.len(), 1);
        // 重复引用不会重复计数
        assert_eq!(collect_refs(&content, &mut refs), 0);
        // 非数组 content（纯文本消息）零引用
        assert_eq!(collect_refs(&json!("plain"), &mut refs), 0);
    }

    #[test]
    fn gc_keeps_referenced_and_young_files() {
        let dir = temp_dir("gc");
        let store = AttachmentStore::new(&dir);
        let kept = format!("{}.png", "a".repeat(64));
        let orphan = format!("{}.png", "b".repeat(64));
        let young = format!("{}.png", "c".repeat(64));
        write_old_file(&store, &kept, b"kept-bytes"); // 老文件，但被引用
        write_old_file(&store, &orphan, b"garbage"); // 老文件，没人引用
        // young：刚写入，不调 mtime
        std::fs::write(store.root().join(&young), b"fresh").unwrap();

        let mut refs = HashSet::new();
        refs.insert(kept.clone());
        let report = store.gc(&refs, Duration::from_secs(1800)).unwrap();

        assert_eq!(report.removed, 1, "{report:?}");
        assert_eq!(report.kept, 1);
        assert_eq!(report.skipped_young, 1);
        assert_eq!(report.freed_bytes, b"garbage".len() as u64);
        assert!(store.root().join(&kept).exists());
        assert!(store.root().join(&young).exists());
        assert!(!store.root().join(&orphan).exists());
    }

    #[test]
    fn gc_removes_stale_parts_and_ignores_foreign_files() {
        let dir = temp_dir("gcparts");
        let store = AttachmentStore::new(&dir);
        let part = format!("{}.png.part", "d".repeat(64));
        write_old_file(&store, &part, b"half-image");
        // 别人放进来的文件：名字不合规 → 永远不碰
        write_old_file(&store, "notes.txt", b"do not touch");

        let report = store.gc(&HashSet::new(), Duration::from_secs(1800)).unwrap();
        assert_eq!(report.removed_parts, 1, "{report:?}");
        assert_eq!(report.removed, 0);
        assert!(!store.root().join(&part).exists());
        assert!(store.root().join("notes.txt").exists());
    }

    #[test]
    fn gc_is_a_noop_on_missing_directory() {
        let dir = temp_dir("gcmissing").join("nested");
        let store = AttachmentStore::new(&dir);
        assert_eq!(
            store.gc(&HashSet::new(), Duration::ZERO).unwrap(),
            GcReport::default()
        );
        assert_eq!(store.usage().unwrap(), (0, 0));
    }

    #[test]
    fn usage_counts_only_managed_files() {
        let dir = temp_dir("usage");
        let store = AttachmentStore::new(&dir);
        let name = format!("{}.png", "e".repeat(64));
        write_old_file(&store, &name, b"12345");
        std::fs::write(store.root().join("notes.txt"), b"ignore").unwrap();
        let (files, bytes) = store.usage().unwrap();
        assert_eq!(files, 1);
        assert_eq!(bytes, 5);
    }
}
