//! `get_current_time` 工具（原生）— 返回当前时间（支持 IANA 时区参数）。
//!
//! ⚠️ 与 TS 侧 `infrastructure/tools/system/get-current-time.ts` 逐字对齐（铁律 1）：模型侧 `content`
//! 固定英文，形状取自 `Intl.DateTimeFormat('en-US', {...})` 的实测输出（`Thursday, 09/25/2025,
//! 10:03:04 AM`）；`uiData` 只下发语言无关的 `{ timestamp, timezone }`，由 UI 按界面语言重建（D2）。
//!
//! 时区数据用 `chrono-tz`（内置 IANA 数据库），与 TS 的 `Intl` 同为 IANA，同一时刻 / 时区名输出一致。
//! 为什么必须引依赖：无 JS 的纯 Rust CLI 里没有 `Intl`，用固定偏移近似会在 DST 切换日出错。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use std::str::FromStr;

/// 默认时区（与 TS `(args.timezone as string) || 'Asia/Shanghai'` 一致）
const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";

/// 模型侧时间格式：`%A, %m/%d/%Y, %I:%M:%S %p` ↔ `Intl` 的 `en-US` 组合输出。
///
/// ⚠️ 与 `Intl` 的对应关系（改一处必须改另一处）：`weekday:'long'`→`%A`、`month:'2-digit'`→`%m`、
/// `day:'2-digit'`→`%d`、`year:'numeric'`→`%Y`、`hour:'2-digit'`→`%I`（12 小时制补零）、
/// `minute`/`second`→`%M`/`%S`、AM/PM→`%p`。chrono 的 `%A` / `%p` 是无本地化的英文常量，与 `en-US`
/// 一致。
const TIME_FORMAT: &str = "%A, %m/%d/%Y, %I:%M:%S %p";

pub(crate) async fn get_current_time_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 取值语义与 JS `(args.timezone as string) || 'Asia/Shanghai'` 对齐：
    // JS 里 `''` / `null` / `undefined` / `0` / `false` 都是 falsy → 回落默认时区，
    // 其余（非空字符串、非零数字、true、对象…）原样交给时区库判定。
    let tz_name = match args.get("timezone") {
        None | Some(Value::Null) => DEFAULT_TIMEZONE.to_string(),
        Some(Value::String(s)) if s.is_empty() => DEFAULT_TIMEZONE.to_string(),
        Some(Value::Bool(false)) => DEFAULT_TIMEZONE.to_string(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => DEFAULT_TIMEZONE.to_string(),
        Some(Value::String(s)) => s.clone(),
        // 非字符串：`String(v)` 语义（与 JS 的字符串化同形；对象/数组的字符串化结果与 JS 不同，
        // 但这条路径只影响「非法时区」的报错文案，不影响任何正常输入）
        Some(other) => other.to_string(),
    };

    let tz = match Tz::from_str(&tz_name) {
        Ok(tz) => tz,
        Err(_) => {
            // 与 TS 侧同样的失败文案（TS 显式做 `Intl` 预校验，见 get-current-time.ts），
            // 并下发结构化 uiData 供 UI 按界面语言重建（D2 的失败侧）
            return Ok(NativeToolOutcome::error_with_ui(
                format!("Invalid time zone: \"{}\"", tz_name),
                json!({ "timezone": tz_name, "errorKind": "invalid_timezone" }),
            ));
        }
    };

    // 同一个 `now` 同时用于格式化与时间戳，避免两次取时产生擦边不一致
    Ok(render(tz, tz_name, Utc::now()))
}

/// 按 [`TIME_FORMAT`] 渲染（`now` 由调用方给出 → 单测可固定时刻，与 `Intl` 逐字比对）
fn render(tz: Tz, tz_name: String, now: DateTime<Utc>) -> NativeToolOutcome {
    let local = now.with_timezone(&tz);
    NativeToolOutcome::Value {
        content: local.format(TIME_FORMAT).to_string(),
        ui_data: Some(json!({
            "timestamp": now.timestamp_millis(),
            "timezone": tz_name,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::execute_native_tool;
    use crate::agent::native_tools::test_util::test_security_bare;
    use chrono::TimeZone;

    fn rfc3339(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn content_and_ui(outcome: &NativeToolOutcome) -> (String, Value) {
        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                (content.clone(), ui_data.clone().unwrap_or(Value::Null))
            }
            other => panic!("expected Value, got {other:?}"),
        }
    }

    /// ground truth 由 Node/ICU 实测得到（node 24.10 / ICU 77.1）：
    /// `new Date('2025-09-25T02:03:04Z').toLocaleString('en-US', { timeZone:'Asia/Shanghai',`
    /// `year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',`
    /// `second:'2-digit', weekday:'long' })` → `"Thursday, 09/25/2025, 10:03:04 AM"`
    #[test]
    fn format_matches_intl_en_us() {
        let now = rfc3339("2025-09-25T02:03:04Z");
        let (content, ui) = content_and_ui(&render(
            Tz::from_str("Asia/Shanghai").unwrap(),
            "Asia/Shanghai".to_string(),
            now,
        ));
        assert_eq!(content, "Thursday, 09/25/2025, 10:03:04 AM");
        assert_eq!(ui["timezone"], json!("Asia/Shanghai"));
        assert_eq!(ui["timestamp"], json!(now.timestamp_millis()));
    }

    /// 12 小时制补零 + 午夜 12 点：UTC `2025-06-01T00:00:00Z` → UTC 下 `12:00:00 AM`
    #[test]
    fn midnight_is_twelve_am() {
        let now = rfc3339("2025-06-01T00:00:00Z");
        let (utc, _) = content_and_ui(&render(Tz::from_str("UTC").unwrap(), "UTC".to_string(), now));
        assert_eq!(utc, "Sunday, 06/01/2025, 12:00:00 AM");
    }

    /// 时区换算 + 补零：上海 = UTC+8 → `08:05:07 AM`（不是 `8:05:07 AM`）
    #[test]
    fn shanghai_offset_and_zero_padding() {
        let now = rfc3339("2025-01-09T00:05:07Z");
        let (content, _) = content_and_ui(&render(
            Tz::from_str("Asia/Shanghai").unwrap(),
            "Asia/Shanghai".to_string(),
            now,
        ));
        assert_eq!(content, "Thursday, 01/09/2025, 08:05:07 AM");
    }

    /// DST 生效日必须靠时区库算（固定偏移近似会错）：美东 2025-03-09 12:30Z = 08:30 EDT
    #[test]
    fn dst_is_handled_by_the_timezone_database() {
        let now = rfc3339("2025-03-09T12:30:00Z");
        let (content, _) = content_and_ui(&render(
            Tz::from_str("America/New_York").unwrap(),
            "America/New_York".to_string(),
            now,
        ));
        assert_eq!(content, "Sunday, 03/09/2025, 08:30:00 AM");
    }

    async fn run(args: Value) -> NativeToolOutcome {
        let dir = std::env::temp_dir().join(format!("virlen_time_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_time",
            tool_call_id: "tc_time",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: crate::agent::native_tools::noop_repo(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };
        let outcome = execute_native_tool(&ctx, "get_current_time", &args)
            .await
            .expect("get_current_time 不应返回 Err");
        std::fs::remove_dir_all(&dir).ok();
        outcome
    }

    /// 缺省参数 → 默认时区，且内容形状与 `Intl` 一致（真实取当前时间，只校验形状）
    #[tokio::test]
    async fn default_timezone_and_content_shape() {
        let (content, ui) = content_and_ui(&run(json!({})).await);
        assert_eq!(ui["timezone"], json!("Asia/Shanghai"));
        assert!(ui["timestamp"].as_i64().unwrap_or(0) > 1_700_000_000_000);
        let re = regex::Regex::new(
            r"^[A-Z][a-z]+day, \d{2}/\d{2}/\d{4}, \d{2}:\d{2}:\d{2} (AM|PM)$",
        )
        .unwrap();
        assert!(re.is_match(&content), "content: {content}");
        let tz = Tz::from_str("Asia/Shanghai").unwrap();
        let expected = Utc
            .timestamp_millis_opt(ui["timestamp"].as_i64().unwrap())
            .unwrap()
            .with_timezone(&tz)
            .format(TIME_FORMAT)
            .to_string();
        assert_eq!(content, expected, "时间戳与展示文本应来自同一时刻");
    }

    /// 空串 / …→ 默认时区（与 JS falsy 判定一致）
    #[tokio::test]
    async fn falsy_timezone_falls_back_to_default() {
        for args in [json!({ "timezone": "" }), json!({ "timezone": null })] {
            let (_, ui) = content_and_ui(&run(args.clone()).await);
            assert_eq!(ui["timezone"], json!("Asia/Shanghai"), "args: {args}");
        }
    }

    /// 非法时区 → 失败（模型侧英文 + 结构化 uiData 供界面本地化）
    #[tokio::test]
    async fn invalid_timezone_is_a_failure_with_structured_ui_data() {
        match run(json!({ "timezone": "Not/AZone" })).await {
            NativeToolOutcome::Error { content, ui_data } => {
                assert_eq!(content, "Invalid time zone: \"Not/AZone\"");
                let ui = ui_data.expect("失败应带 uiData");
                assert_eq!(ui["errorKind"], json!("invalid_timezone"));
                assert_eq!(ui["timezone"], json!("Not/AZone"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }
}
