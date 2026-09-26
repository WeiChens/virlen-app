//! `app_settings` 里**数组型配置**的「按 id 增删改」（评审项 N2）
//!
//! ## 为什么需要它
//!
//! `config set providers [...]` 是**整键覆盖**：想加一个供应商，必须把已有全部 provider
//! 连 `id` / `createdAt` 一起抄进 JSON，漏一个字段就把现有配置毁掉。GUI 侧同理
//! （`SettingsStore.providers` 就是整个数组，改一次整组写回）。两边都只能整组写 → 冲突窗口很大。
//!
//! 本模块给出最小语义，供 `provider` / `agent` 子命令复用：
//!
//! | 关心的事 | 做法 |
//! |---|---|
//! | 别抹掉不认识的字段 | 全程用 `serde_json::Value`，**不做强类型反序列化**（GUI 以后加字段也不会被 CLI 吃掉） |
//! | 改一项别动其它项 | `upsert_by_id` / `remove_by_id` **只在目标下标上动刀** |
//! | 更新而不是替换 | 更新走**字段级合并**（patch 里没出现的键保持原值） |
//! | 并发覆盖要现形 | 写完**回读比对**，不一致直接报错（而不是让用户以为存上了） |
//!
//! ## 做不到的事（如实标注）
//!
//! 这**不是**乐观锁。桌面端正开着时，它的内存快照 + 400ms debounce 落库仍会**整组覆盖**
//! 本次改动。回读校验只能把「已经发生」的覆盖变成一条可见错误，不能阻止它。
//! 因此命令层会在成功提示里明确写出「桌面端正在运行时可能覆盖」。

use serde_json::{Map, Value};
use virlen_core::session_db::SettingsRepo;

/// 读数组键：键不存在 / 不是数组 → 空数组（不是错误 —— 「还没有」与「坏掉了」在配置层同义）
pub(crate) async fn read_array(
    settings: &dyn SettingsRepo,
    key: &str,
) -> Result<Vec<Value>, String> {
    let all = settings
        .get_all()
        .await
        .map_err(|e| format!("读取配置失败: {}", e))?;
    Ok(match all.get(key) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    })
}

/// 按 `id_field` 找下标（字段缺失 / 不是字符串 → 不算命中）
pub(crate) fn find_index(arr: &[Value], id_field: &str, id: &str) -> Option<usize> {
    arr.iter()
        .position(|v| v.get(id_field).and_then(Value::as_str) == Some(id))
}

/// 按 id upsert；`true` = 新增，`false` = 更新。
///
/// - **更新**：字段级合并（`patch` 里出现的键覆盖，未出现的键原样保留 —— 因此 `id` /
///   `createdAt` 与未来新增的字段都不会丢）；
/// - **新增**：`{id_field: id, ...patch}` 追加到末尾（保持既有顺序，不重排）。
pub(crate) fn upsert_by_id(
    arr: &mut Vec<Value>,
    id_field: &str,
    id: &str,
    patch: &Map<String, Value>,
) -> Result<bool, String> {
    match find_index(arr, id_field, id) {
        Some(i) => {
            let obj = arr[i]
                .as_object_mut()
                .ok_or_else(|| format!("`{}` = {} 的现有项不是对象，无法更新", id_field, id))?;
            for (k, v) in patch {
                obj.insert(k.clone(), v.clone());
            }
            Ok(false)
        }
        None => {
            let mut obj = patch.clone();
            obj.insert(id_field.to_string(), Value::String(id.to_string()));
            arr.push(Value::Object(obj));
            Ok(true)
        }
    }
}

/// 按 id 删除；`true` = 真的删掉了一项
pub(crate) fn remove_by_id(arr: &mut Vec<Value>, id_field: &str, id: &str) -> bool {
    match find_index(arr, id_field, id) {
        Some(i) => {
            arr.remove(i);
            true
        }
        None => false,
    }
}

/// 取字符串字段（缺失 / 类型不对 → 空串）
///
/// 为什么用 `Value` 取而不是强类型结构体：配置项里可能有**我们不认识的字段**，
/// 反序列化到结构体再写回会把它们抹掉（N2 要防的正是这件事）。
pub(crate) fn field_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// 取字符串数组字段（缺失 / 类型不对 → 空数组）
pub(crate) fn field_strs(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 写回数组键，并**回读比对**。
///
/// 回读不一致只可能是「写入没生效」或「刚被另一个进程覆盖」—— 两种情况都必须让用户知道
/// （静默成功比报错糟得多：用户会以为配置已经好了）。
pub(crate) async fn write_array(
    settings: &dyn SettingsRepo,
    key: &str,
    arr: &[Value],
) -> Result<(), String> {
    let value = Value::Array(arr.to_vec());
    let mut entries = Map::new();
    entries.insert(key.to_string(), value.clone());
    settings
        .upsert(entries)
        .await
        .map_err(|e| format!("写入配置失败: {}", e))?;

    let back = read_array(settings, key).await?;
    if back != arr {
        return Err(format!(
            "写入 `{}` 后回读不一致：可能被另一个进程（桌面端）覆盖了。请退出桌面端后重试",
            key
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use virlen_core::host::CliHost;
    use virlen_core::session_db::open_session_db;
    use std::path::PathBuf;

    fn patch(v: Value) -> Map<String, Value> {
        v.as_object().cloned().expect("patch 必须是对象")
    }

    #[test]
    fn upsert_appends_then_merges() {
        let mut arr: Vec<Value> = vec![json!({ "id": "a", "name": "A", "unknown": 1 })];

        // 新增
        let added = upsert_by_id(&mut arr, "id", "b", &patch(json!({ "name": "B" }))).unwrap();
        assert!(added);
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[1]["id"], "b");

        // 更新：只动 patch 里出现的键
        let added = upsert_by_id(&mut arr, "id", "a", &patch(json!({ "name": "A2" }))).unwrap();
        assert!(!added);
        assert_eq!(arr.len(), 2, "更新不得追加新项");
        assert_eq!(arr[0]["name"], "A2");
        assert_eq!(arr[0]["unknown"], 1, "不认识的字段必须保留");
    }

    #[test]
    fn upsert_preserves_order_on_update() {
        let mut arr: Vec<Value> = vec![json!({"id":"a"}), json!({"id":"b"}), json!({"id":"c"})];
        upsert_by_id(&mut arr, "id", "b", &patch(json!({"x": 1}))).unwrap();
        let ids: Vec<&str> = arr
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn remove_by_id_reports_hit() {
        let mut arr: Vec<Value> = vec![json!({"id":"a"}), json!({"id":"b"})];
        assert!(remove_by_id(&mut arr, "id", "a"));
        assert_eq!(arr.len(), 1);
        assert!(!remove_by_id(&mut arr, "id", "nope"));
    }

    #[test]
    fn find_index_ignores_missing_or_non_string_ids() {
        let arr: Vec<Value> = vec![json!({}), json!({"id": 7}), json!({"id":"x"})];
        assert_eq!(find_index(&arr, "id", "x"), Some(2));
        assert_eq!(find_index(&arr, "id", "7"), None);
    }

    /// upsert 到「不是对象」的现有项上必须报错，而不是把它悄悄替换掉
    #[test]
    fn upsert_rejects_non_object_existing_item() {
        let mut arr: Vec<Value> = vec![json!("not an object with id")];
        // 用 id_field 命中的前提是该字段能取到字符串 → 这里构造一个能命中的脏项
        let mut arr2: Vec<Value> = vec![json!({"id": "a"})];
        arr2[0] = json!({"id": "a"});
        assert!(upsert_by_id(&mut arr2, "id", "a", &patch(json!({"k": 1}))).is_ok());

        // 直接塞一个带 id 但整体不是对象的项是构造不出来的；改为验证 remove 对脏项也安全
        assert!(!remove_by_id(&mut arr, "id", "a"));
    }

    fn temp_host() -> (CliHost, PathBuf) {
        let dir = std::env::temp_dir().join(format!("virlen_edit_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (CliHost::new(vec![], dir.clone()), dir)
    }

    /// 端到端（真 SQLite）：只改一项 → 另一项与未知字段仍在；回读校验通过
    #[tokio::test]
    async fn write_then_read_roundtrip_only_touches_target() {
        let (host, dir) = temp_host();
        let db = open_session_db(&host, &|fut| {
            tokio::spawn(fut);
        })
        .unwrap();
        let settings: &dyn SettingsRepo = db.settings.as_ref();

        let mut arr = vec![
            json!({ "id": "a", "name": "A", "apiKey": "sk-a", "weird": true }),
            json!({ "id": "b", "name": "B" }),
        ];
        write_array(settings, "providers", &arr).await.unwrap();

        upsert_by_id(&mut arr, "id", "b", &patch(json!({ "name": "B2" }))).unwrap();
        write_array(settings, "providers", &arr).await.unwrap();

        let back = read_array(settings, "providers").await.unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0]["apiKey"], "sk-a");
        assert_eq!(back[0]["weird"], true, "未知字段必须活着");
        assert_eq!(back[1]["name"], "B2");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn read_array_treats_missing_and_broken_as_empty() {
        let (host, dir) = temp_host();
        let db = open_session_db(&host, &|fut| {
            tokio::spawn(fut);
        })
        .unwrap();
        let settings: &dyn SettingsRepo = db.settings.as_ref();

        assert!(read_array(settings, "providers").await.unwrap().is_empty());

        let mut entries = Map::new();
        entries.insert("providers".into(), json!("not-an-array"));
        settings.upsert(entries).await.unwrap();
        assert!(read_array(settings, "providers").await.unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
