//! 图片附件外置的落库/读取契约（P0-1）：
//! **写入路径把内联 base64 换成 `attachment://` 引用，`get_context_messages` 再按需还原。**
//!
//! 为什么必须有这一层：外置逻辑写在 `SqliteSessionRepo` 的写路径上，单测 `attachment` 模块
//! 只证明「函数本身对」，这里证明「引擎 / 前端真正写入时确实走了它」。

use super::{open_tmp_with_path, test_message, test_session};
use crate::agent::types::Message;
use crate::attachment::{self, AttachmentStore};
use crate::session_db::maintenance::DbMaintenance;
use crate::session_db::repo::SessionRepo;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;

const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nfake-bytes-for-tests";

fn png_data_url() -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(PNG_BYTES))
}

fn message_with_image(id: &str, url: &str) -> Message {
    let mut message = test_message(id, "user");
    message.content = json!([
        { "type": "text", "text": "看图" },
        { "type": "image_url", "image_url": { "url": url, "detail": "auto" } },
    ]);
    message
}

fn url_at(message: &Message, index: usize) -> &str {
    message.content[index]["image_url"]["url"].as_str().unwrap()
}

/// 引用 → 附件目录里的绝对路径（`<库目录>/attachments/<name>`）
fn attachment_path(db: &std::path::Path, reference: &str) -> std::path::PathBuf {
    let name = reference.strip_prefix(attachment::PREFIX).unwrap();
    db.parent().unwrap().join("attachments").join(name)
}

#[tokio::test]
async fn append_externalizes_images_and_context_resolves_them() {
    let (repo, db) = open_tmp_with_path();
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    repo.append_messages("s1", &[message_with_image("m1", &png_data_url())])
        .await
        .unwrap();

    // ① 库里只剩引用：base64 不再进 messages 表
    let stored = repo.get_messages("s1").await.unwrap();
    let reference = url_at(&stored[0], 1).to_string();
    assert!(reference.starts_with(attachment::PREFIX), "{reference}");
    assert!(
        !stored[0].content[1].to_string().contains("base64"),
        "落库内容不应再含 base64: {}",
        stored[0].content
    );

    // ② 字节真的落到了库同级的 attachments 目录（与 virlen.db 一起搬迁）
    let path = attachment_path(&db, &reference);
    assert!(path.is_file(), "附件未落盘: {}", path.display());
    assert_eq!(std::fs::read(&path).unwrap(), PNG_BYTES);

    // ③ 交给模型的那份（get_context_messages）已经还原成 data URL
    let context = repo.get_context_messages("s1").await.unwrap();
    assert_eq!(url_at(&context[0], 1), png_data_url());
}

#[tokio::test]
async fn both_replace_paths_externalize_too() {
    let (repo, db) = open_tmp_with_path();
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    let image = message_with_image("m1", &png_data_url());

    // 全量替换
    repo.replace_messages("s1", std::slice::from_ref(&image))
        .await
        .unwrap();
    let stored = repo.get_messages("s1").await.unwrap();
    assert!(url_at(&stored[0], 1).starts_with(attachment::PREFIX));

    // 后缀替换（前端「删除某条及之后 + 回写窗口」走这条）
    let mut assistant = test_message("m2", "assistant");
    assistant.content = json!("好的");
    repo.replace_messages_from("s1", "m1", &[image, assistant])
        .await
        .unwrap();
    let stored = repo.get_messages("s1").await.unwrap();
    assert!(url_at(&stored[0], 1).starts_with(attachment::PREFIX));
    assert_eq!(stored.len(), 2);

    // 同一份字节只落一个文件（内容寻址去重）
    let names = AttachmentStore::new(db.parent().unwrap())
        .list_names()
        .unwrap();
    assert_eq!(names.len(), 1, "{names:?}");
}

#[tokio::test]
async fn references_round_trip_through_writes() {
    let (repo, _db) = open_tmp_with_path();
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    // 先落一条会生成引用
    repo.append_messages("s1", &[message_with_image("m1", &png_data_url())])
        .await
        .unwrap();
    let reference = url_at(&repo.get_messages("s1").await.unwrap()[0], 1).to_string();

    // 前端把这一页重新写回（含引用）：不应报错、不应二次外置、内容保持引用
    let stored = repo.get_messages("s1").await.unwrap();
    repo.append_messages("s1", &stored).await.unwrap();
    let after = repo.get_messages("s1").await.unwrap();
    assert_eq!(url_at(&after[0], 1), reference);
    assert_eq!(after.len(), 1, "同 id 覆盖写，不应多出一行");
}

#[tokio::test]
async fn missing_attachment_degrades_to_text_on_resolve() {
    let (repo, _db) = open_tmp_with_path();
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    // 伪造一个「指向不存在文件」的合法引用
    let dangling = format!("{}{}.png", attachment::PREFIX, "b".repeat(64));
    repo.append_messages("s1", &[message_with_image("m1", &dangling)])
        .await
        .unwrap();

    let context = repo.get_context_messages("s1").await.unwrap();
    let block = &context[0].content[1];
    assert_eq!(block["type"], "text", "{}", block);
    assert!(block["text"].as_str().unwrap().contains("图片不可用"));
    // 库里仍是引用（读取不写回，避免把降级结果固化）
    let stored = repo.get_messages("s1").await.unwrap();
    assert_eq!(stored[0].content[1]["image_url"]["url"], json!(dangling));
}

/// 引用扫描 + 回收的端到端：删掉一条消息后，它引用的图片应当被回收，别的不动。
///
/// 真实际景：用户删了几条带截图的对话，库里变小了，但图片文件必须也跟着清。
#[tokio::test]
async fn gc_removes_orphans_but_keeps_referenced_images() {
    let (repo, db) = open_tmp_with_path();
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    // 两张不同的图（内容不同 → 两个不同附件）
    let mut first = message_with_image("m1", &png_data_url());
    first.content[1]["image_url"]["url"] = json!(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(b"first-image")
    ));
    let mut second = message_with_image("m2", &png_data_url());
    second.content[1]["image_url"]["url"] = json!(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(b"second-image")
    ));
    repo.append_messages("s1", &[first, second]).await.unwrap();
    assert_eq!(
        AttachmentStore::new(db.parent().unwrap())
            .list_names()
            .unwrap()
            .len(),
        2,
        "两张图都应落盘"
    );

    // 删掉第二条（及其之后）→ 它的图片失去引用
    repo.truncate_messages_from("s1", "m2").await.unwrap();

    let maintenance = DbMaintenance::new(db.clone(), repo.conn.clone());
    // grace = 0：测试里不等待“文件变旧”（真实调用传 30 分钟）
    let report = maintenance
        .gc_attachments(std::time::Duration::ZERO)
        .await
        .unwrap();

    assert_eq!(report.removed, 1, "{report:?}");
    assert_eq!(report.kept, 1);
    assert!(report.freed_bytes > 0);
    assert_eq!(
        AttachmentStore::new(db.parent().unwrap())
            .list_names()
            .unwrap()
            .len(),
        1,
        "只剩仍被引用的那张"
    );
    // 删掉的确实是 m2 那张：m1 仍能还原成 data URL
    let context = repo.get_context_messages("s1").await.unwrap();
    assert!(
        context[0].content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"),
        "仍被引用的图必须完整可读"
    );
}

/// grace 阀：刚写入的文件即使暂时没有引用也不能删（引擎先落盘再写库）。
#[tokio::test]
async fn gc_skips_recent_files_within_grace() {
    let (repo, db) = open_tmp_with_path();
    repo.upsert_session(&test_session("s1", "t", 100))
        .await
        .unwrap();
    let mut message = message_with_image("m1", &png_data_url());
    message.content[1]["image_url"]["url"] = json!(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(b"just-uploaded")
    ));
    repo.append_messages("s1", &[message]).await.unwrap();
    repo.truncate_messages_from("s1", "m1").await.unwrap();

    let maintenance = DbMaintenance::new(db.clone(), repo.conn.clone());
    let report = maintenance
        .gc_attachments(std::time::Duration::from_secs(30 * 60))
        .await
        .unwrap();

    assert_eq!(report.removed, 0, "{report:?}");
    assert_eq!(report.skipped_young, 1);
    assert_eq!(
        AttachmentStore::new(db.parent().unwrap())
            .list_names()
            .unwrap()
            .len(),
        1
    );
}
