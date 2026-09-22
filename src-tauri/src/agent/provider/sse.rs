//! SSE 流式响应逐行读取（对齐 TS `readStreamLines`）
//!
//! OpenAI / Anthropic 两个原生 Provider 共用：按 `\n` 切 chunk 成行，
//! 每行回调一次；回调返回 `false` 时提前结束（用于 tool_use 等场景）。

use super::super::cancellation::CancellationToken;

/// 逐 chunk 读取响应体并按行回调（对齐 TS readStreamLines）
pub(super) async fn read_sse_lines(
    mut response: reqwest::Response,
    cancel: &CancellationToken,
    on_line: &mut (dyn FnMut(String) -> bool + Send),
) -> Result<(), String> {
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            chunk = response.chunk() => chunk.map_err(|e| format!("SSE 读取失败: {}", e))?,
        };
        match chunk {
            Some(bytes) => {
                buffer.extend_from_slice(&bytes);
                while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=pos).collect();
                    let end = line.len().saturating_sub(1);
                    let line_str = String::from_utf8_lossy(&line[..end]).to_string();
                    if !on_line(line_str) {
                        return Ok(());
                    }
                }
            }
            None => break,
        }
    }
    Ok(())
}
