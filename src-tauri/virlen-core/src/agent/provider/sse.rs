//! SSE 流式响应逐行读取（对齐 TS `readStreamLines`）
//!
//! OpenAI / Anthropic 两个原生 Provider 共用：按 `\n` 切 chunk 成行，
//! 每行回调一次；回调返回 `false` 时提前结束（用于 tool_use 等场景）。
//!
//! ⚠️ **静默兜底**（2026-09-29，见 `docs/phone-control-bridge.md` §27）：读循环除「每行回调」外，
//! 还会在**长时间没有新 chunk** 时回调一次 [`SseItem::Idle`]。原因：引擎的流式节流器会把
//! 最后一段增量**扣押**到「下一次有事件」才发；而 provider 在「正文结束 → 首个工具参数分片」
//! 之间可能整段时间零 chunk（服务端生成中 / 参数非增量下发）—— 没有 Idle，扣住的正文尾部
//! 要等到该轮 `MessageStop` 才可见，用户看到的就是「停在半句话，该轮结束才补全」。
//! 定时器与「有没有 chunk」无关，故能把尾部可见延迟钉在一个确定的上界内。

use super::super::cancellation::CancellationToken;

/// 静默兜底间隔（毫秒）。
///
/// 取值只需「比正常流式的 chunk 间隔大、比人眼可感知的停顿小」：正常流式每几到几十毫秒一个
/// chunk，不会触发；一旦真的静默，最多这么久就把尾部刷出去。100ms 相对一帧（16ms）留了余量。
const IDLE_TICK_MS: u64 = 100;

/// SSE 读取回调项：要么是一行数据，要么是「静默心跳」。
pub(super) enum SseItem {
    /// 一行（已切掉行尾 `\n`）。
    Line(String),
    /// 距上一个 chunk 已超过 [`IDLE_TICK_MS`]。
    Idle,
}

/// 逐 chunk 读取响应体并按行回调（对齐 TS readStreamLines）；
/// 静默超过 [`IDLE_TICK_MS`] 时回调一次 [`SseItem::Idle`]。
pub(super) async fn read_sse_lines(
    mut response: reqwest::Response,
    cancel: &CancellationToken,
    on_item: &mut (dyn FnMut(SseItem) -> bool + Send),
) -> Result<(), String> {
    let mut buffer: Vec<u8> = Vec::new();
    let idle = std::time::Duration::from_millis(IDLE_TICK_MS);
    loop {
        // ⚠️ 这里让 sleep 与 `response.chunk()` 同台竞争：sleep 胜出时会 **drop** 掉 `chunk()`。
        //    之所以安全：`reqwest::Response::chunk` 内部就是 `body_mut().frame().await`，
        //    返回 `Pending` 时**不会取走任何字节**（状态留在 body 里），故 drop 后重新 `chunk()`
        //    不会丢数据 —— 不像「裸 `timeout` 包住一个带中间状态的 future」那样危险。
        tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            _ = tokio::time::sleep(idle) => {
                // 静默期：给上层一次「把节流器里扣着的正文尾部刷出去」的机会
                if !on_item(SseItem::Idle) {
                    return Ok(());
                }
            }
            chunk = response.chunk() => {
                match chunk.map_err(|e| format!("SSE read failed: {}", e))? {
                    Some(bytes) => {
                        buffer.extend_from_slice(&bytes);
                        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buffer.drain(..=pos).collect();
                            let end = line.len().saturating_sub(1);
                            let line_str = String::from_utf8_lossy(&line[..end]).to_string();
                            if !on_item(SseItem::Line(line_str)) {
                                return Ok(());
                            }
                        }
                    }
                    None => break,
                }
            }
        }
    }
    Ok(())
}
